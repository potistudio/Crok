import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { createAudioResource, StreamType } from "@discordjs/voice";
import ffmpegPath from "ffmpeg-static";
import { loadTrack, normalizeTrackUrl, openTrackStream, Track } from "../src/music/AudioSource";
import { parseMusicCommand } from "../src/music/MusicCommands";
import { createMusicEmbed, createNowPlayingEmbed } from "../src/music/MusicEmbeds";
import { createResponseEmbeds } from "../src/responder/ResponderMessages";

/** Offline smoke test: real yt-dlp process boundary, FFmpeg encoder and Opus demuxer. */
async function main() {
	assert.deepEqual(parseMusicCommand("!play https://youtu.be/jNQXAC9IVRw"), {
		name: "play",
		argument: "https://youtu.be/jNQXAC9IVRw",
	});
	for (const name of ["pause", "resume", "skip", "stop", "queue"]) {
		assert.deepEqual(parseMusicCommand(`!${name}`), { name, argument: "" });
	}
	assert.equal(parseMusicCommand("!stopwatch"), null);
	assert.equal(parseMusicCommand("普通のメッセージ"), null);
	console.log("PASS music message command parsing");
	const card = createNowPlayingEmbed(
		{
			url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
			title: "Test track",
			requestedBy: "123",
			duration: 125,
			thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
		},
		"456",
		3
	).toJSON();
	assert.equal(card.title, "🎶 再生中");
	assert.equal(card.fields?.find((field) => field.name === "長さ")?.value, "2:05");
	assert.equal(card.fields?.find((field) => field.name === "待機")?.value, "3曲");
	assert(card.thumbnail);
	assert.equal(
		createNowPlayingEmbed(
			{ url: "https://snd.sc/ABC123", title: "SoundCloud track", requestedBy: "123" },
			"456",
			0
		)
			.toJSON()
			.fields?.find((field) => field.name === "音源")?.value,
		"SoundCloud"
	);
	assert.equal(createMusicEmbed("Error", "Error", true).toJSON().color, 0xed4245);
	assert.equal(createMusicEmbed("a".repeat(5000)).toJSON().description?.length, 4096);
	console.log("PASS music Embed serialization, duration, thumbnail and error styling");
	const response = "あ".repeat(3999) + "🎵" + "長い返答\n".repeat(1000);
	const responseCards = createResponseEmbeds(response).map((embed) => embed.toJSON());
	assert.equal(responseCards.map((embed) => embed.description).join(""), response);
	assert(responseCards.every((embed) => (embed.description?.length ?? 0) <= 4000));
	assert.equal(createResponseEmbeds("error", true)[0].toJSON().color, 0xed4245);
	console.log("PASS AI reply Embed serialization and long Unicode response splitting");
	assert.equal(
		normalizeTrackUrl("https://youtu.be/jNQXAC9IVRw?list=test"),
		"https://www.youtube.com/watch?v=jNQXAC9IVRw"
	);
	assert.throws(() => normalizeTrackUrl("https://youtube.com.example.org/watch?v=jNQXAC9IVRw"));
	assert(ffmpegPath);
	const directory = await mkdtemp(join(tmpdir(), "crok-music-check-"));
	const previousPath = process.env.YT_DLP_PATH;
	try {
		const wav = spawnSync(ffmpegPath, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000",
			"-t",
			"0.2",
			"-f",
			"wav",
			"pipe:1",
		]);
		assert.equal(wav.status, 0, wav.stderr.toString());
		const fixturePath = join(directory, "tone.wav");
		await writeFile(fixturePath, wav.stdout);
		const executable = join(directory, "yt-dlp-stub");
		await writeFile(
			executable,
			`#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--dump-single-json")) {
  const url = process.argv.at(-1);
  const info = { title: "Local audio fixture", duration: 0.2, thumbnail: "https://example.com/cover.jpg", extractor_key: url.includes("soundcloud.com") ? "Soundcloud" : "Youtube" };
  if (url.includes("/sets/")) info.entries = [];
  if (url.includes("/live/")) info.is_live = true;
  console.log(JSON.stringify(info));
} else {
  process.stdout.write(fs.readFileSync(${JSON.stringify(fixturePath)}));
}
`,
			{ mode: 0o700 }
		);
		process.env.YT_DLP_PATH = executable;
		for (const url of [
			"https://www.youtube.com/watch?v=jNQXAC9IVRw",
			"https://soundcloud.com/artist/song",
		]) {
			const track: Track = { url, title: url, requestedBy: "check" };
			await loadTrack(track, new AbortController().signal);
			assert.equal(track.title, "Local audio fixture");
			assert.equal(track.duration, 0.2);
			assert.equal(track.thumbnail, "https://example.com/cover.jpg");
			const audio = openTrackStream(track);
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of audio.stream)
					chunks.push(Buffer.from(chunk as Uint8Array));
				const ogg = Buffer.concat(chunks);
				assert.equal(ogg.toString("ascii", 0, 4), "OggS");
				assert(ogg.includes(Buffer.from("OpusHead")));
				const resource = createAudioResource(Readable.from([ogg]), {
					inputType: StreamType.OggOpus,
				});
				let packets = 0;
				for await (const packet of resource.playStream) {
					assert(Buffer.isBuffer(packet));
					packets++;
				}
				assert(packets > 0);
				console.log(
					`PASS ${new URL(url).hostname}: metadata → FFmpeg Ogg/Opus → Discord demux (${packets} packets)`
				);
			} finally {
				audio.cleanup();
			}
		}
		for (const url of [
			"https://soundcloud.com/artist/sets/album",
			"https://youtube.com/live/test",
		]) {
			await assert.rejects(
				loadTrack({ url, title: "", requestedBy: "check" }, new AbortController().signal),
				/対応していません/
			);
		}
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			loadTrack(
				{ url: "https://soundcloud.com/artist/song", title: "", requestedBy: "check" },
				controller.signal
			)
		);
		process.env.YT_DLP_PATH = join(directory, "missing-yt-dlp");
		await assert.rejects(
			loadTrack(
				{ url: "https://soundcloud.com/artist/song", title: "", requestedBy: "check" },
				new AbortController().signal
			),
			/見つかりません/
		);
		console.log("PASS playlist/live rejection, aborted lookup, missing executable");
	} finally {
		if (previousPath === undefined) delete process.env.YT_DLP_PATH;
		else process.env.YT_DLP_PATH = previousPath;
		await rm(directory, { recursive: true, force: true });
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
