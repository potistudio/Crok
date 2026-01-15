import { Client, GatewayIntentBits, Events } from "discord.js";
import {
	joinVoiceChannel,
	getVoiceConnection,
	VoiceConnectionStatus,
	DiscordGatewayAdapterCreator,
	createAudioPlayer,
	createAudioResource,
	StreamType,
} from "@discordjs/voice";
import { join } from "path";
import { existsSync } from "fs";
import dotenv from "dotenv";
import { haikuDetector, HaikuMatch } from "./haiku/HaikuDetector";
import { simplifierService } from "./simplifier/SimplifierService";
import { shouldPoliceUiUx, UI_UX_POLICE_MESSAGE } from "./police/UiUxPolice";
import { soundSequencer } from "./sequencer/SoundSequencer";
import { responderService } from "./responder/ResponderService";

dotenv.config();

// デバッグモードの設定
const DEBUG_MODE = process.env.DEBUG === "true";
if (DEBUG_MODE) {
	console.log("🐛 Debug mode enabled");
	haikuDetector.debug = true;
	simplifierService.debug = true;
	responderService.debug = true;
}

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
	],
});

// 起動時に俳句検出器を初期化
haikuDetector
	.initialize()
	.then(() => {
		console.log("Haiku detector initialized.");
	})
	.catch((err) => {
		console.error("Failed to initialize haiku detector:", err);
	});

// 俳句の返信をフォーマット
function formatHaikuReply(match: HaikuMatch): string {
	return `🎋 **俳句を検出しました！**\n\`\`\`\n${match.kami}\n　${match.naka}\n　　${match.shimo}\n\`\`\``;
}

// Mention Reply (Grok応答)
const RESPONDER_CHANNEL_ID = process.env.RESPONDER_CHANNEL_ID;

client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot) return;

	// 指定チャンネルでのみ応答
	if (!RESPONDER_CHANNEL_ID || message.channel.id !== RESPONDER_CHANNEL_ID) return;

	if (client.user && message.mentions.has(client.user)) {
		try {
			// メンション部分を除去してユーザーのメッセージを抽出
			const userMessage = message.content.replace(/<@!?\d+>/g, "").trim();

			const response = await responderService.respond(userMessage);
			if (response) {
				await message.reply(response);
				console.log(
					`Responded to ${message.author.tag}: "${userMessage.substring(0, 30)}..."`
				);
			} else {
				// フォールバック
				await message.reply("🤔");
			}
		} catch (err) {
			console.error("Responder error:", err);
			await message.reply("⚠️ エラーが発生しました");
		}
	}
});

// 俳句検出
client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot) return;

	try {
		const match = await haikuDetector.detect(message.content);
		if (match) {
			const reply = formatHaikuReply(match);
			await message.reply(reply);
			console.log(`Haiku detected from ${message.author.tag}: ${match.text}`);
		}
	} catch (err) {
		console.error("Haiku detection error:", err);
	}
});

// 冗長な文章の要約
client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot) return;

	try {
		const simplified = await simplifierService.simplify(message.content);
		if (simplified) {
			await message.reply({
				content: simplified,
				files: ["./assets/red.jpg"],
			});
			console.log(`Simplified message from ${message.author.tag}`);
		}
	} catch (err) {
		console.error("Simplifier error:", err);
	}
});

// Auto VC Join/Leave
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
	// Ignore bot's own voice state updates
	if (newState.member?.user.bot) return;

	const channel = newState.channel;
	const oldChannel = oldState.channel;

	// User Joined a VC or Moved to a new VC
	if (channel && channel.id !== oldChannel?.id) {
		// Join the channel
		joinVoiceChannel({
			channelId: channel.id,
			guildId: channel.guild.id,
			adapterCreator: channel.guild
				.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
		});
		console.log(`Joined channel: ${channel.name} because ${newState.member?.user.tag} joined.`);
	}
	// User Left a VC
	else if (!channel && oldChannel) {
		// If the bot is in the channel the user left, check if it's empty
		const connection = getVoiceConnection(oldChannel.guild.id);
		if (connection && connection.joinConfig.channelId === oldChannel.id) {
			// Check if there are other humans in the channel
			const nonBotMembers = oldChannel.members.filter((m) => !m.user.bot);
			if (nonBotMembers.size === 0) {
				connection.destroy();
				console.log(`Left channel: ${oldChannel.name} because it is empty.`);
			}
		}
	}
});

client.once(Events.ClientReady, (c) => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
});

// 丸画像送信
client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot) return;

	if (message.content === "○") {
		try {
			await message.reply({
				files: ["./assets/red.jpg"],
			});
		} catch (error) {
			console.error("Failed to send red image:", error);
			// エラー時はユーザーに通知（任意）
			// await message.reply('画像の送信に失敗しました。管理者にお問い合わせください。');
		}
	}
});

// UI/UX Police
client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot) return;

	if (shouldPoliceUiUx(message.content)) {
		await message.reply(UI_UX_POLICE_MESSAGE);
	}
});

// Sound Sequencer
client.on(Events.MessageCreate, async (message) => {
	await soundSequencer.processMessage(message);
});

client.login(process.env.DISCORD_TOKEN);
