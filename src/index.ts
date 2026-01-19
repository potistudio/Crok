import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
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
import { logger, createLogger } from "./utils/logger";

dotenv.config();

const log = createLogger("main");

// デバッグモードの設定
const DEBUG_MODE = process.env.DEBUG === "true";
if (DEBUG_MODE) {
	log.info("Debug mode enabled");
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
		log.info("Haiku detector initialized.");
	})
	.catch((err) => {
		log.error("Failed to initialize haiku detector:", err);
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
			await message.channel.sendTyping();

			// メンション部分を除去してユーザーのメッセージを抽出
			const userMessage = message.content.replace(/<@!?\d+>/g, "").trim();

			const response = await responderService.respond(userMessage);
			if (response) {
				await message.reply(response);
				log.info(
					`Responded to ${message.author.tag}: "${userMessage.substring(0, 30)}..."`
				);
			} else {
				// フォールバック
				await message.reply("🤔");
			}
		} catch (err) {
			log.error("Responder error:", err);
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
			log.info(`Haiku detected from ${message.author.tag}: ${match.text}`);
		}
	} catch (err) {
		log.error("Haiku detection error:", err);
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
			log.info(`Simplified message from ${message.author.tag}`);
		}
	} catch (err) {
		log.error("Simplifier error:", err);
	}
});

// Slash Commands Definition
const commands = [
	new SlashCommandBuilder()
		.setName("join")
		.setDescription("BotをVCに参加させます"),
	new SlashCommandBuilder()
		.setName("leave")
		.setDescription("BotをVCから退出させます"),
	new SlashCommandBuilder()
		.setName("random")
		.setDescription("ランダム間隔で音を再生します")
		.addSubcommand(sub =>
			sub.setName("start")
				.setDescription("ランダム再生を開始")
				.addIntegerOption(opt => opt.setName("min").setDescription("最小間隔(秒)").setRequired(false))
				.addIntegerOption(opt => opt.setName("max").setDescription("最大間隔(秒)").setRequired(false))
		)
		.addSubcommand(sub =>
			sub.setName("stop")
				.setDescription("ランダム再生を停止")
		),
];

// Register Slash Commands on Ready
client.once(Events.ClientReady, async (c) => {
	log.info(`Ready! Logged in as ${c.user.tag}`);

	// Register commands
	const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);
	try {
		log.info("Registering slash commands...");
		await rest.put(
			Routes.applicationCommands(c.user.id),
			{ body: commands.map(cmd => cmd.toJSON()) }
		);
		log.info("Slash commands registered.");
	} catch (err) {
		log.error("Failed to register slash commands:", err);
	}
});

// Random Sound Playback State
const randomSoundTimers: Map<string, NodeJS.Timeout> = new Map();

function scheduleRandomSound(guildId: string, soundPath: string, minMs: number, maxMs: number) {
	const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;

	const timer = setTimeout(() => {
		const connection = getVoiceConnection(guildId);
		if (!connection) {
			randomSoundTimers.delete(guildId);
			return;
		}

		try {
			const player = createAudioPlayer();
			const resource = createAudioResource(soundPath);
			connection.subscribe(player);
			player.play(resource);
			log.info(`[Random] Played sound for guild ${guildId}`);
		} catch (err) {
			log.error("[Random] Playback error:", err);
		}

		// Schedule next
		scheduleRandomSound(guildId, soundPath, minMs, maxMs);
	}, delay);

	randomSoundTimers.set(guildId, timer);
}

// Slash Command Handler
client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	if (!interaction.guild) return;

	const { commandName } = interaction;

	// /join
	if (commandName === "join") {
		const member = interaction.member;
		// @ts-ignore - voice property exists on GuildMember
		const voiceChannel = member?.voice?.channel;
		if (!voiceChannel) {
			await interaction.reply({ content: "⚠️ VCに参加してからコマンドを実行してください", ephemeral: true });
			return;
		}

		joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: interaction.guild.id,
			adapterCreator: interaction.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
		});
		await interaction.reply(`🔊 ${voiceChannel.name} に参加しました`);
		log.info(`Joined channel: ${voiceChannel.name} via /join from ${interaction.user.tag}`);
		return;
	}

	// /leave
	if (commandName === "leave") {
		const connection = getVoiceConnection(interaction.guild.id);
		if (!connection) {
			await interaction.reply({ content: "⚠️ VCに参加していません", ephemeral: true });
			return;
		}

		connection.destroy();
		await interaction.reply("👋 VCから退出しました");
		log.info(`Left channel via /leave from ${interaction.user.tag}`);
		return;
	}

	// /random start|stop
	if (commandName === "random") {
		const subcommand = interaction.options.getSubcommand();

		if (subcommand === "start") {
			const minSec = interaction.options.getInteger("min") ?? 30;
			const maxSec = interaction.options.getInteger("max") ?? 120;

			const connection = getVoiceConnection(interaction.guild.id);
			if (!connection) {
				await interaction.reply({ content: "⚠️ まずBotをVCに参加させてください (`/join`)", ephemeral: true });
				return;
			}

			const soundPath = join(__dirname, "assets", "Metal Pipe.wav");
			const finalPath = existsSync(soundPath) ? soundPath : join(__dirname, "../assets", "Metal Pipe.wav");

			if (randomSoundTimers.has(interaction.guild.id)) {
				clearTimeout(randomSoundTimers.get(interaction.guild.id)!);
			}

			scheduleRandomSound(interaction.guild.id, finalPath, minSec * 1000, maxSec * 1000);
			await interaction.reply(`🎲 ランダム再生開始: ${minSec}〜${maxSec}秒間隔`);
			log.info(`[Random] Started for guild ${interaction.guild.id} (${minSec}-${maxSec}s)`);
			return;
		}

		if (subcommand === "stop") {
			const timer = randomSoundTimers.get(interaction.guild.id);
			if (timer) {
				clearTimeout(timer);
				randomSoundTimers.delete(interaction.guild.id);
				await interaction.reply("⏹️ ランダム再生を停止しました");
				log.info(`[Random] Stopped for guild ${interaction.guild.id}`);
			} else {
				await interaction.reply({ content: "⚠️ ランダム再生は実行されていません", ephemeral: true });
			}
			return;
		}
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
		log.info(`Joined channel: ${channel.name} because ${newState.member?.user.tag} joined.`);
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
				log.info(`Left channel: ${oldChannel.name} because it is empty.`);
			}
		}
	}
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
			log.error("Failed to send red image:", error);
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
