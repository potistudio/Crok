import { EmbedBuilder, Message } from "discord.js";

export function createResponseEmbeds(text: string, error = false): EmbedBuilder[] {
	const chunks: string[] = [];
	let chunk = "";
	for (const character of text) {
		if (chunk.length + character.length > 4000) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) chunks.push(chunk);
	return chunks.map((description) =>
		new EmbedBuilder()
			.setColor(error ? 0xed4245 : 0x5865f2)
			.setAuthor({ name: "Crok" })
			.setDescription(description)
	);
}

export async function replyWithEmbeds(
	message: Message,
	text: string,
	error = false
): Promise<void> {
	for (const embed of createResponseEmbeds(text, error)) {
		await message.reply({
			embeds: [embed],
			allowedMentions: { parse: [], repliedUser: false },
		});
	}
}
