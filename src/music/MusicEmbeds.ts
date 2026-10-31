import { EmbedBuilder, escapeMarkdown } from "discord.js";
import type { Track } from "./AudioSource";

export function createMusicEmbed(
	description: string,
	title = "🎵 Crok Music",
	error = false
): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(error ? 0xed4245 : 0x5865f2)
		.setTitle(title)
		.setDescription(description.slice(0, 4096) || "曲の情報はありません。")
		.setFooter({ text: "!play URL · !pause · !resume · !skip · !stop · !queue" });
}

export function createNowPlayingEmbed(
	track: Track,
	channelId: string,
	queued: number
): EmbedBuilder {
	const duration =
		track.duration === undefined
			? "不明"
			: `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, "0")}`;
	const source = new URL(track.url).hostname.includes("youtu") ? "YouTube" : "SoundCloud";
	const embed = createMusicEmbed(escapeMarkdown(track.title), "🎶 再生中")
		.setURL(track.url)
		.addFields(
			{ name: "音源", value: source, inline: true },
			{ name: "長さ", value: duration, inline: true },
			{ name: "待機", value: `${queued}曲`, inline: true },
			{ name: "リクエスト", value: `<@${track.requestedBy}>`, inline: true },
			{ name: "ボイスチャンネル", value: `<#${channelId}>`, inline: true }
		);
	if (track.thumbnail) embed.setThumbnail(track.thumbnail);
	return embed;
}
