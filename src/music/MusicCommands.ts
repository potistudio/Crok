import { ChannelType, Message } from "discord.js";
import { musicService } from "./MusicService";
import { createMusicEmbed } from "./MusicEmbeds";

type MusicCommandName = "play" | "pause" | "resume" | "skip" | "stop" | "queue";

export function parseMusicCommand(
	content: string
): { name: MusicCommandName; argument: string } | null {
	const match = /^!(play|pause|resume|skip|stop|queue)(?:\s+([\s\S]*))?$/i.exec(content.trim());
	if (!match) return null;
	return { name: match[1].toLowerCase() as MusicCommandName, argument: (match[2] ?? "").trim() };
}

export async function handleMusicMessage(
	message: Message,
	stopRandomSound: (guildId: string) => void
): Promise<boolean> {
	const command = parseMusicCommand(message.content);
	if (!command || message.author.bot || !message.inGuild()) return false;
	const reply = async (content: string) => {
		const title = content.startsWith("⚠️")
			? "⚠️ 操作できませんでした"
			: command.name === "queue"
				? "🎶 再生キュー"
				: "🎵 Crok Music";
		await message.reply({
			embeds: [createMusicEmbed(content, title, content.startsWith("⚠️"))],
			allowedMentions: { parse: [], repliedUser: false },
		});
	};
	try {
		if (command.name !== "play" && command.argument) {
			throw new Error(`使い方: !${command.name}`);
		}
		if (command.name === "play" && !command.argument) {
			throw new Error("使い方: !play <YouTubeまたはSoundCloudの曲のURL>");
		}
		if (command.name === "queue") {
			await reply(musicService.describe(message.guild.id));
			return true;
		}
		const member = await message.guild.members.fetch(message.author.id);
		const voiceChannel = member.voice.channel;
		if (!voiceChannel) throw new Error("VCに参加してから実行してください。");
		const activeChannel = musicService.getChannelId(message.guild.id);
		if (activeChannel && activeChannel !== voiceChannel.id) {
			throw new Error("Botが音楽を再生しているVCに参加してください。");
		}
		let content: string;
		if (command.name === "play") {
			if (voiceChannel.type !== ChannelType.GuildVoice)
				throw new Error("通常のボイスチャンネルで実行してください。");
			if (!voiceChannel.joinable || !voiceChannel.speakable)
				throw new Error("このVCに接続・発言する権限がありません。");
			const url = command.argument.replace(/^<(\S+)>$/, "$1");
			const position = musicService.enqueue(
				message.guild,
				voiceChannel,
				url,
				message.author.id,
				async (notification) => {
					if (message.channel.isSendable())
						await message.channel.send({
							embeds: [notification],
							allowedMentions: { parse: [] },
						});
				}
			);
			stopRandomSound(message.guild.id);
			content = `🎵 キューに追加しました（再生順: ${position}）。`;
		} else if (command.name === "pause") {
			content = musicService.pause(message.guild.id)
				? "⏸️ 一時停止しました。"
				: "一時停止できる曲はありません。";
		} else if (command.name === "resume") {
			content = musicService.resume(message.guild.id)
				? "▶️ 再生を再開しました。"
				: "一時停止中の曲はありません。";
		} else if (command.name === "skip") {
			content = musicService.skip(message.guild.id)
				? "⏭️ 次の曲に進みます。"
				: "再生中の曲はありません。";
		} else {
			content = musicService.stop(message.guild.id)
				? "⏹️ 再生を停止し、キューを消去しました。"
				: "再生中の曲はありません。";
		}
		await reply(content);
	} catch (error) {
		await reply(`⚠️ ${error instanceof Error ? error.message : "音楽の操作に失敗しました。"}`);
	}
	return true;
}
