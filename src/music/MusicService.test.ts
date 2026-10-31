import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createAudioPlayer, entersState, joinVoiceChannel } from "@discordjs/voice";
import type { EmbedBuilder, Guild, VoiceBasedChannel } from "discord.js";
import { loadTrack, openTrackStream } from "./AudioSource";
import { MusicService } from "./MusicService";

vi.mock("../utils/logger", () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock("./AudioSource", async (importOriginal) => ({
	...(await importOriginal<typeof import("./AudioSource")>()),
	loadTrack: vi.fn(),
	openTrackStream: vi.fn(),
}));
vi.mock("@discordjs/voice", async () => {
	const { EventEmitter } = await import("node:events");
	class Player extends EventEmitter {
		state: { status: string; resource?: unknown } = { status: "idle" };
		play(resource: unknown) {
			this.change({ status: "playing", resource });
		}
		stop() {
			this.change({ status: "idle" });
			return true;
		}
		pause() {
			this.state.status = "paused";
			return true;
		}
		unpause() {
			this.state.status = "playing";
			return true;
		}
		change(state: { status: string; resource?: unknown }) {
			const old = this.state;
			this.state = state;
			this.emit("stateChange", old, state);
		}
	}
	return {
		AudioPlayerStatus: { Idle: "idle", Playing: "playing", Paused: "paused" },
		VoiceConnectionStatus: {
			Ready: "ready",
			Destroyed: "destroyed",
			Disconnected: "disconnected",
		},
		NoSubscriberBehavior: { Pause: "pause" },
		StreamType: { OggOpus: "ogg/opus" },
		createAudioPlayer: vi.fn(() => new Player()),
		createAudioResource: vi.fn((_stream, options: { metadata: unknown }) => options),
		entersState: vi.fn((target: unknown) => Promise.resolve(target)),
		joinVoiceChannel: vi.fn(() =>
			Object.assign(new EventEmitter(), {
				state: { status: "ready" },
				subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
				destroy: vi.fn(),
			})
		),
	};
});

const guild = { id: "guild", voiceAdapterCreator: {} } as Guild;
const channel = { id: "vc" } as VoiceBasedChannel;
const url = "https://youtu.be/jNQXAC9IVRw";
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("music playback lifecycle", () => {
	let service: MusicService;
	let notify: ReturnType<typeof vi.fn<(message: EmbedBuilder) => Promise<void>>>;
	beforeEach(() => {
		vi.clearAllMocks();
		service = new MusicService();
		notify = vi.fn(async () => {});
		vi.mocked(entersState).mockImplementation((target) => Promise.resolve(target));
		vi.mocked(loadTrack).mockImplementation((track) => {
			track.title = "Test song";
			return Promise.resolve();
		});
		vi.mocked(openTrackStream).mockImplementation(() => ({
			stream: new PassThrough(),
			cleanup: vi.fn(),
		}));
	});

	it("queues requests in order and advances exactly once on track completion", async () => {
		expect(service.enqueue(guild, channel, url, "u1", notify)).toBe(1);
		expect(
			service.enqueue(guild, channel, "https://soundcloud.com/artist/song", "u2", notify)
		).toBe(2);
		await flush();
		expect(loadTrack).toHaveBeenCalledTimes(1);
		const player = vi.mocked(createAudioPlayer).mock.results[0].value as ReturnType<
			typeof createAudioPlayer
		>;
		player.stop(true);
		await flush();
		expect(loadTrack).toHaveBeenCalledTimes(2);
		player.stop(true);
		await flush();
		expect(service.isActive(guild.id)).toBe(false);
	});

	it("clears the queue and cleans up subprocesses when stopped", async () => {
		service.enqueue(guild, channel, url, "u", notify);
		service.enqueue(guild, channel, url, "u", notify);
		await flush();
		const audio = vi.mocked(openTrackStream).mock.results[0].value as ReturnType<
			typeof openTrackStream
		>;
		service.stop(guild.id);
		await flush();
		expect(audio.cleanup).toHaveBeenCalledOnce();
		const connection = vi.mocked(joinVoiceChannel).mock.results[0].value as ReturnType<
			typeof joinVoiceChannel
		>;
		expect(connection.listenerCount("stateChange")).toBe(0);
		expect(service.isActive(guild.id)).toBe(false);
		expect(loadTrack).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending lookup on skip and ignores its late completion", async () => {
		let resolveLookup!: () => void;
		vi.mocked(loadTrack).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveLookup = resolve;
				})
		);
		service.enqueue(guild, channel, url, "u", notify);
		service.enqueue(guild, channel, url, "u", notify);
		await flush();
		const signal = vi.mocked(loadTrack).mock.calls[0][1];
		service.skip(guild.id);
		await flush();
		expect(signal.aborted).toBe(true);
		resolveLookup();
		await flush();
		expect(openTrackStream).toHaveBeenCalledOnce();
		service.stop(guild.id);
	});

	it("continues after lookup and stream failures", async () => {
		vi.mocked(loadTrack).mockRejectedValueOnce(new Error("Unavailable"));
		service.enqueue(guild, channel, url, "u", notify);
		service.enqueue(guild, channel, url, "u", notify);
		await flush();
		expect(loadTrack).toHaveBeenCalledTimes(2);
		const audio = vi.mocked(openTrackStream).mock.results[0].value as ReturnType<
			typeof openTrackStream
		>;
		audio.stream.destroy(new Error("Stream lost"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(service.isActive(guild.id)).toBe(false);
		expect(
			notify.mock.calls.some(([embed]) => embed.toJSON().description?.includes("失敗"))
		).toBe(true);
	});

	it("isolates guilds and rejects enqueueing from another VC", async () => {
		service.enqueue(guild, channel, url, "u", notify);
		expect(() =>
			service.enqueue(guild, { id: "other" } as VoiceBasedChannel, url, "u", notify)
		).toThrow("VC");
		const otherGuild = { ...guild, id: "other-guild" } as Guild;
		service.enqueue(otherGuild, channel, url, "u", notify);
		await flush();
		service.stop(guild.id);
		expect(service.isActive(otherGuild.id)).toBe(true);
		service.stop(otherGuild.id);
	});

	it("supports pause/resume and stops on destroyed connections", async () => {
		service.enqueue(guild, channel, url, "u", notify);
		await flush();
		expect(service.pause(guild.id)).toBe(true);
		expect(service.describe(guild.id)).toContain("一時停止中");
		expect(service.resume(guild.id)).toBe(true);
		const connection = vi.mocked(joinVoiceChannel).mock.results[0].value as ReturnType<
			typeof joinVoiceChannel
		>;
		(connection as EventEmitter).emit(
			"stateChange",
			{ status: "ready" },
			{ status: "destroyed" }
		);
		expect(service.isActive(guild.id)).toBe(false);
	});

	it("bounds the queue and does not join for invalid URLs", () => {
		expect(() => service.enqueue(guild, channel, "https://example.com", "u", notify)).toThrow();
		expect(joinVoiceChannel).not.toHaveBeenCalled();
		for (let i = 0; i < 51; i++) service.enqueue(guild, channel, url, "u", notify);
		expect(() => service.enqueue(guild, channel, url, "u", notify)).toThrow("50");
		service.stop(guild.id);
	});

	it("ignores a connection attempt that finishes after stop", async () => {
		let connect!: () => void;
		vi.mocked(entersState).mockImplementationOnce(
			(target) =>
				new Promise((resolve) => {
					connect = () => resolve(target);
				})
		);
		service.enqueue(guild, channel, url, "u", notify);
		service.stop(guild.id);
		connect();
		await flush();
		expect(loadTrack).not.toHaveBeenCalled();
		expect(openTrackStream).not.toHaveBeenCalled();
	});

	it("clears all tracks when the initial voice connection times out", async () => {
		vi.mocked(entersState).mockImplementationOnce((target) => {
			(target.state as { status: string }).status = "connecting";
			return Promise.reject(new Error("Connection timeout"));
		});
		service.enqueue(guild, channel, url, "u", notify);
		service.enqueue(guild, channel, url, "u", notify);
		await flush();
		expect(service.isActive(guild.id)).toBe(false);
		expect(loadTrack).not.toHaveBeenCalled();
		const connection = vi.mocked(joinVoiceChannel).mock.results[0].value as ReturnType<
			typeof joinVoiceChannel
		>;
		expect(connection.listenerCount("stateChange")).toBe(0);
	});
});
