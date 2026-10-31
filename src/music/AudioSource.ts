import { execFile, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtempSync, rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";

export interface Track {
	url: string;
	title: string;
	requestedBy: string;
	duration?: number;
	thumbnail?: string;
}

/** Accept individual tracks only; never pass arbitrary URLs/options to yt-dlp. */
export function normalizeTrackUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("YouTubeまたはSoundCloudの曲のURLを指定してください。");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
		throw new Error("YouTubeまたはSoundCloudの曲のURLを指定してください。");
	}
	const host = url.hostname.toLowerCase();
	if (
		[
			"youtube.com",
			"www.youtube.com",
			"m.youtube.com",
			"music.youtube.com",
			"youtu.be",
			"www.youtu.be",
		].includes(host)
	) {
		const id = host.endsWith("youtu.be")
			? url.pathname.slice(1)
			: url.pathname === "/watch"
				? url.searchParams.get("v")
				: /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
		if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
			throw new Error(
				"YouTubeの動画URLを指定してください。プレイリストには対応していません。"
			);
		}
		return `https://www.youtube.com/watch?v=${id}`;
	}
	if (["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host)) {
		const parts = url.pathname.split("/").filter(Boolean);
		if (
			parts.length < 2 ||
			parts.length > 3 ||
			["sets", "likes", "tracks", "albums", "reposts"].includes(parts[1]) ||
			(parts.length === 3 && !/^s-[A-Za-z0-9]+$/.test(parts[2]))
		) {
			throw new Error("SoundCloudの単曲URLを指定してください。セットには対応していません。");
		}
		url.hostname = "soundcloud.com";
	} else if (
		["on.soundcloud.com", "snd.sc"].includes(host) &&
		/^\/[A-Za-z0-9]+\/?$/.test(url.pathname)
	) {
		// yt-dlp resolves official share links; metadata validation rejects sets.
	} else {
		throw new Error("YouTubeまたはSoundCloudの曲のURLに対応しています。");
	}
	url.protocol = "https:";
	url.hash = "";
	return url.toString();
}

function downloaderArgs(): string[] {
	return [
		"--ignore-config",
		"--no-plugin-dirs",
		"--no-cache-dir",
		"--no-playlist",
		"--no-warnings",
		"--no-progress",
		"--socket-timeout",
		"15",
		"--retries",
		"2",
		"--extractor-retries",
		"2",
		"--js-runtimes",
		`node:${process.execPath}`,
	];
}

export async function loadTrack(track: Track, signal: AbortSignal): Promise<void> {
	const output = await new Promise<string>((resolve, reject) => {
		execFile(
			process.env.YT_DLP_PATH || "yt-dlp",
			[
				...downloaderArgs(),
				"--dump-single-json",
				"--skip-download",
				"--format",
				"bestaudio/best",
				"--",
				track.url,
			],
			{ signal, timeout: 45_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => {
				if (error) {
					reject(
						new Error(
							error.code === "ENOENT"
								? "yt-dlpが見つかりません。インストールするかYT_DLP_PATHを設定してください。"
								: "曲情報を取得できませんでした。URL・公開状態、yt-dlpの更新状況を確認してください。"
						)
					);
				} else {
					resolve(stdout);
				}
			}
		);
	});
	const info = JSON.parse(output) as {
		title?: unknown;
		entries?: unknown;
		is_live?: unknown;
		live_status?: unknown;
		extractor_key?: unknown;
		duration?: unknown;
		thumbnail?: unknown;
	};
	if (info.entries || info.is_live === true || info.live_status === "is_upcoming") {
		throw new Error(
			"単曲のURLを指定してください。プレイリスト・セット・ライブ配信には対応していません。"
		);
	}
	if (
		typeof info.extractor_key !== "string" ||
		!/^(Youtube|Soundcloud)$/i.test(info.extractor_key)
	) {
		throw new Error("YouTubeまたはSoundCloudの単曲URLを指定してください。");
	}
	if (typeof info.title !== "string" || !info.title.trim()) {
		throw new Error("曲名を取得できませんでした。");
	}
	track.title = info.title.slice(0, 150);
	if (typeof info.duration === "number" && Number.isFinite(info.duration) && info.duration >= 0) {
		track.duration = info.duration;
	}
	if (typeof info.thumbnail === "string") {
		try {
			const thumbnail = new URL(info.thumbnail);
			if (["https:", "http:"].includes(thumbnail.protocol))
				track.thumbnail = thumbnail.toString();
		} catch {
			// A missing or malformed image must not prevent audio playback.
		}
	}
}

/** Stream via FFmpeg as Ogg/Opus, avoiding full downloads and a native Opus addon. */
export function openTrackStream(track: Track): { stream: PassThrough; cleanup: () => void } {
	if (!ffmpegPath) throw new Error("FFmpegが見つかりません。");
	// Native HLS downloading may create fragment files even with stdout output.
	const directory = mkdtempSync(join(tmpdir(), "crok-music-"));
	const downloader = spawn(
		process.env.YT_DLP_PATH || "yt-dlp",
		[...downloaderArgs(), "--format", "bestaudio/best", "--output", "-", "--", track.url],
		{ stdio: ["ignore", "pipe", "pipe"], cwd: directory }
	);
	const encoder = spawn(
		ffmpegPath,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			"pipe:0",
			"-vn",
			"-ac",
			"2",
			"-ar",
			"48000",
			"-c:a",
			"libopus",
			"-b:a",
			"128k",
			"-f",
			"ogg",
			"pipe:1",
		],
		{ stdio: ["pipe", "pipe", "pipe"] }
	);
	const stream = new PassThrough();
	let closed = false;
	let processesClosed = 0;
	for (const child of [downloader, encoder]) {
		child.once("close", () => {
			processesClosed++;
			if (processesClosed === 2) {
				rm(directory, { recursive: true, force: true }, (error) => {
					if (error) console.warn("Failed to remove music fragments:", error);
				});
			}
		});
	}
	const cleanup = () => {
		if (closed) return;
		closed = true;
		downloader.stdout.unpipe(encoder.stdin);
		encoder.stdout.unpipe(stream);
		for (const child of [downloader, encoder]) {
			child.kill();
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 2000);
			timer.unref();
			child.once("close", () => clearTimeout(timer));
		}
		stream.destroy();
	};
	const fail = (message: string) => {
		if (!closed) stream.destroy(new Error(message));
	};
	// Consume stderr to avoid blocking subprocesses; do not expose signed URLs in chat.
	downloader.stderr.resume();
	encoder.stderr.resume();
	downloader.on("error", () =>
		fail("音源を取得できませんでした。yt-dlpの設定を確認してください。")
	);
	encoder.on("error", () => fail("FFmpegを起動できませんでした。"));
	encoder.stdin.on("error", () => fail("音声変換に失敗しました。"));
	downloader.on("close", (code) => {
		if (code !== 0)
			fail("音源を取得できませんでした。公開状態やyt-dlpの更新状況を確認してください。");
	});
	encoder.on("close", (code) => {
		if (code !== 0) fail("音声変換に失敗しました。");
	});
	stream.once("close", cleanup);
	downloader.stdout.pipe(encoder.stdin);
	encoder.stdout.pipe(stream);
	return { stream, cleanup };
}
