import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, EmbedBuilder, Message, MessageReplyOptions } from "discord.js";
import { handleMusicMessage, parseMusicCommand } from "./MusicCommands";

const music = vi.hoisted(() => ({
	enqueue: vi.fn(() => 1),
	getChannelId: vi.fn<() => string | undefined>(() => undefined),
	describe: vi.fn(() => "Test queue"),
	pause: vi.fn(() => true),
	resume: vi.fn(() => true),
	skip: vi.fn(() => true),
	stop: vi.fn(() => true),
}));
vi.mock("./MusicService", () => ({ musicService: music }));

function makeMessage(content: string) {
	const voiceChannel = {
		id: "voice",
		type: ChannelType.GuildVoice,
		joinable: true,
		speakable: true,
	};
	const reply = vi.fn<(options: MessageReplyOptions) => Promise<void>>(() => Promise.resolve());
	const fetch = vi.fn(() =>
		Promise.resolve({ voice: { channel: voiceChannel as typeof voiceChannel | null } })
	);
	const raw = {
		content,
		author: { id: "user", bot: false },
		inGuild: () => true,
		guild: { id: "guild", members: { fetch } },
		channel: { isSendable: () => true, send: vi.fn(() => Promise.resolve()) },
		reply,
	};
	return { message: raw as unknown as Message, raw, voiceChannel, fetch, reply };
}

function replyEmbed(reply: ReturnType<typeof makeMessage>["reply"]) {
	return (reply.mock.calls[0][0].embeds?.[0] as EmbedBuilder).toJSON();
}

describe("music message commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		music.getChannelId.mockReturnValue(undefined);
		music.enqueue.mockReturnValue(1);
	});

	it.each([
		"!play https://youtu.be/jNQXAC9IVRw",
		"!pause",
		"!resume",
		"!skip",
		"!stop",
		"!queue",
	])("recognizes %s", (content) => {
		expect(parseMusicCommand(content)).not.toBeNull();
	});
	it.each([
		"普通の会話",
		"!stopwatch",
		"!playlist",
		"途中に !stop",
		"/music play",
		"https://youtu.be/jNQXAC9IVRw",
	])("does not consume ordinary messages: %s", (content) => {
		expect(parseMusicCommand(content)).toBeNull();
	});
	it("supports surrounding whitespace, newlines and uppercase commands", () => {
		expect(parseMusicCommand("  !PLAY\nhttps://soundcloud.com/artist/song  ")).toEqual({
			name: "play",
			argument: "https://soundcloud.com/artist/song",
		});
	});
	it("enqueues bracketed URLs and stops random sounds only after success", async () => {
		const { message, voiceChannel, reply } = makeMessage(
			"!play <https://soundcloud.com/artist/song>"
		);
		const stopRandom = vi.fn();
		expect(await handleMusicMessage(message, stopRandom)).toBe(true);
		expect(music.enqueue).toHaveBeenCalledWith(
			message.guild,
			voiceChannel,
			"https://soundcloud.com/artist/song",
			"user",
			expect.any(Function)
		);
		expect(stopRandom).toHaveBeenCalledWith("guild");
		expect(replyEmbed(reply).description).toBe("🎵 キューに追加しました（再生順: 1）。");
		expect(reply.mock.calls[0][0].content).toBeUndefined();
		expect(reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
	});
	it("reports invalid input without stopping random sounds", async () => {
		music.enqueue.mockImplementationOnce(() => {
			throw new Error("Invalid URL");
		});
		const { message, reply } = makeMessage("!play https://example.com");
		const stopRandom = vi.fn();
		await handleMusicMessage(message, stopRandom);
		expect(stopRandom).not.toHaveBeenCalled();
		expect(replyEmbed(reply).description).toBe("⚠️ Invalid URL");
		expect(replyEmbed(reply).color).toBe(0xed4245);
	});
	it.each(["!play", "!pause extra"])("explains invalid command syntax: %s", async (content) => {
		const { message, fetch, reply } = makeMessage(content);
		await handleMusicMessage(message, vi.fn());
		expect(fetch).not.toHaveBeenCalled();
		expect(replyEmbed(reply).description).toBe(
			content === "!play"
				? "⚠️ 使い方: !play <YouTubeまたはSoundCloudの曲のURL>"
				: "⚠️ 使い方: !pause"
		);
	});
	it("shows the queue without requiring a VC", async () => {
		const { message, fetch, reply } = makeMessage("!queue");
		await handleMusicMessage(message, vi.fn());
		expect(fetch).not.toHaveBeenCalled();
		expect(replyEmbed(reply).description).toBe("Test queue");
		expect(replyEmbed(reply).title).toBe("🎶 再生キュー");
	});
	it("requires joining a VC to control music", async () => {
		const { message, fetch, reply } = makeMessage("!stop");
		fetch.mockResolvedValueOnce({ voice: { channel: null } });
		await handleMusicMessage(message, vi.fn());
		expect(music.stop).not.toHaveBeenCalled();
		expect(replyEmbed(reply).description).toBe("⚠️ VCに参加してから実行してください。");
	});
	it("rejects control from another VC", async () => {
		music.getChannelId.mockReturnValueOnce("other-vc");
		const { message, reply } = makeMessage("!skip");
		await handleMusicMessage(message, vi.fn());
		expect(music.skip).not.toHaveBeenCalled();
		expect(replyEmbed(reply).description).toBe(
			"⚠️ Botが音楽を再生しているVCに参加してください。"
		);
	});
	it.each(["pause", "resume", "skip", "stop"] as const)(
		"routes !%s to playback controls",
		async (name) => {
			await handleMusicMessage(makeMessage(`!${name}`).message, vi.fn());
			expect(music[name]).toHaveBeenCalledWith("guild");
		}
	);
	it("ignores bots, DMs and non-command messages", async () => {
		const bot = makeMessage("!stop");
		bot.raw.author.bot = true;
		const dm = makeMessage("!stop");
		dm.raw.inGuild = () => false;
		for (const item of [bot, dm, makeMessage("普通の会話")]) {
			expect(await handleMusicMessage(item.message, vi.fn())).toBe(false);
			expect(item.reply).not.toHaveBeenCalled();
		}
	});
});
