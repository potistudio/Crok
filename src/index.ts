import { Client, GatewayIntentBits, Events } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, DiscordGatewayAdapterCreator } from '@discordjs/voice';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates
	]
});

// Mention Reply
client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot) return;

	if (client.user && message.mentions.has(client.user)) {
		const emojis = ['🖕'];
		const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

		await message.channel.send(randomEmoji);
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
			adapterCreator: channel.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
		});
		console.log(`Joined channel: ${channel.name} because ${newState.member?.user.tag} joined.`);
	}
	// User Left a VC
	else if (!channel && oldChannel) {
		// If the bot is in the channel the user left, check if it's empty
		const connection = getVoiceConnection(oldChannel.guild.id);
		if (connection && connection.joinConfig.channelId === oldChannel.id) {
			// Check if there are other humans in the channel
			const nonBotMembers = oldChannel.members.filter(m => !m.user.bot);
			if (nonBotMembers.size === 0) {
				connection.destroy();
				console.log(`Left channel: ${oldChannel.name} because it is empty.`);
			}
		}
	}
});

client.once(Events.ClientReady, c => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
