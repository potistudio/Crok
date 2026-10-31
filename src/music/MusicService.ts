import {
	AudioPlayer,
	AudioPlayerStatus,
	NoSubscriberBehavior,
	PlayerSubscription,
	StreamType,
	VoiceConnection,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
} from "@discordjs/voice";
import { EmbedBuilder, Guild, VoiceBasedChannel, escapeMarkdown } from "discord.js";
import { loadTrack, normalizeTrackUrl, openTrackStream, Track } from "./AudioSource";
import { createLogger } from "../utils/logger";
import { createMusicEmbed, createNowPlayingEmbed } from "./MusicEmbeds";

const log = createLogger("music");
const MAX_QUEUE = 50;
type Notify = (message: EmbedBuilder) => Promise<void>;
interface Playback {
	track: Track;
	abort: AbortController;
	cleanup?: () => void;
}
interface Session {
	guildId: string;
	channelId: string;
	connection: VoiceConnection;
	player: AudioPlayer;
	subscription?: PlayerSubscription;
	queue: Track[];
	run?: Playback;
	notify: Notify;
	onConnectionState: (
		oldState: { status: VoiceConnectionStatus },
		newState: { status: VoiceConnectionStatus }
	) => void;
}

export class MusicService {
	private sessions = new Map<string, Session>();

	isActive(guildId: string): boolean {
		return this.sessions.has(guildId);
	}

	getChannelId(guildId: string): string | undefined {
		return this.sessions.get(guildId)?.channelId;
	}

	enqueue(
		guild: Guild,
		channel: VoiceBasedChannel,
		input: string,
		requestedBy: string,
		notify: Notify
	): number {
		const url = normalizeTrackUrl(input);
		let session = this.sessions.get(guild.id);
		if (session && session.channelId !== channel.id) {
			throw new Error("Botが音楽を再生しているVCに参加してください。");
		}
		if (session && session.queue.length >= MAX_QUEUE) {
			throw new Error(`キューには最大${MAX_QUEUE}曲まで追加できます。`);
		}
		if (!session) {
			const connection = joinVoiceChannel({
				guildId: guild.id,
				channelId: channel.id,
				adapterCreator: guild.voiceAdapterCreator,
				selfDeaf: true,
			});
			const player = createAudioPlayer({
				behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
			});
			session = {
				guildId: guild.id,
				channelId: channel.id,
				connection,
				player,
				queue: [],
				notify,
				onConnectionState: () => {},
			};
			const created = session;
			created.onConnectionState = (_old, state) => {
				if (state.status === VoiceConnectionStatus.Destroyed) this.stop(guild.id);
				if (state.status === VoiceConnectionStatus.Disconnected) {
					void entersState(connection, VoiceConnectionStatus.Ready, 15_000).catch(() => {
						if (this.sessions.get(guild.id) !== created) return;
						this.report(created, "⚠️ VCへの接続が切れたため、音楽を停止しました。");
						this.stop(guild.id);
						if (connection.state.status !== VoiceConnectionStatus.Destroyed)
							connection.destroy();
					});
				}
			};
			connection.on("stateChange", created.onConnectionState);
			player.on("stateChange", (oldState, state) => {
				if (
					state.status !== AudioPlayerStatus.Idle ||
					oldState.status === AudioPlayerStatus.Idle
				)
					return;
				if (created.run && oldState.resource.metadata === created.run)
					this.finish(created, created.run);
			});
			player.on("error", (error) => {
				if (created.run && error.resource.metadata === created.run) {
					this.report(
						created,
						`⚠️ ${escapeMarkdown(created.run.track.title)}の再生に失敗しました。次の曲に進みます。`
					);
					log.warn("Audio playback failed", { message: error.message });
					this.finish(created, created.run);
				}
			});
			this.sessions.set(guild.id, created);
			created.subscription = connection.subscribe(player);
		}
		const position = session.queue.length + (session.run ? 1 : 0) + 1;
		session.queue.push({ url, title: url, requestedBy });
		void this.playNext(session);
		return position;
	}

	pause(guildId: string): boolean {
		return this.sessions.get(guildId)?.player.pause() ?? false;
	}

	resume(guildId: string): boolean {
		return this.sessions.get(guildId)?.player.unpause() ?? false;
	}

	skip(guildId: string): boolean {
		const session = this.sessions.get(guildId);
		if (!session?.run) return false;
		this.finish(session, session.run);
		return true;
	}

	stop(guildId: string): boolean {
		const session = this.sessions.get(guildId);
		if (!session) return false;
		this.sessions.delete(guildId);
		session.queue = [];
		const run = session.run;
		session.run = undefined;
		run?.abort.abort();
		run?.cleanup?.();
		session.player.stop(true);
		session.subscription?.unsubscribe();
		session.connection.off("stateChange", session.onConnectionState);
		// Keep the existing VC connection available for Crok's sound effects.
		return true;
	}

	describe(guildId: string): string {
		const session = this.sessions.get(guildId);
		if (!session) return "🎵 再生中の曲はありません。";
		const lines = session.queue
			.slice(0, 10)
			.map((track, i) => `${i + 1}. ${escapeMarkdown(track.title)}`);
		const status =
			session.player.state.status === AudioPlayerStatus.Paused
				? "一時停止中"
				: session.player.state.status === AudioPlayerStatus.Idle
					? "読み込み中"
					: "再生中";
		return [
			`🎵 ${status}: ${escapeMarkdown(session.run?.track.title ?? "なし")}`,
			`待機: ${session.queue.length}曲`,
			...lines,
		]
			.join("\n")
			.slice(0, 1900);
	}

	private report(session: Session, message: string | EmbedBuilder): void {
		const embed =
			typeof message === "string"
				? createMusicEmbed(message, "⚠️ 再生エラー", true)
				: message;
		void session
			.notify(embed)
			.catch((error: unknown) => log.warn("Failed to send music notification", { error }));
	}

	private finish(session: Session, run: Playback): void {
		if (session.run !== run) return;
		session.run = undefined;
		run.abort.abort();
		run.cleanup?.();
		session.player.stop(true);
		void this.playNext(session);
	}

	private async playNext(session: Session): Promise<void> {
		if (this.sessions.get(session.guildId) !== session || session.run) return;
		const track = session.queue.shift();
		if (!track) {
			this.stop(session.guildId);
			return;
		}
		const run: Playback = { track, abort: new AbortController() };
		session.run = run;
		try {
			await entersState(
				session.connection,
				VoiceConnectionStatus.Ready,
				AbortSignal.any([run.abort.signal, AbortSignal.timeout(20_000)])
			);
			if (session.run !== run) return;
			await loadTrack(track, run.abort.signal);
			if (session.run !== run) return;
			const audio = openTrackStream(track);
			run.cleanup = audio.cleanup;
			// A failed pipeline can emit before the player's demuxer attaches.
			audio.stream.on("error", (error) => {
				if (session.run !== run) return;
				log.warn("Music stream failed", { message: error.message });
				this.report(session, "⚠️ 音源の取得・変換に失敗しました。次の曲に進みます。");
				this.finish(session, run);
			});
			const resource = createAudioResource(audio.stream, {
				inputType: StreamType.OggOpus,
				metadata: run,
			});
			session.player.play(resource);
			await entersState(
				session.player,
				AudioPlayerStatus.Playing,
				AbortSignal.any([run.abort.signal, AbortSignal.timeout(30_000)])
			);
			if (session.run === run)
				this.report(
					session,
					createNowPlayingEmbed(track, session.channelId, session.queue.length)
				);
		} catch (error) {
			if (session.run !== run) return;
			if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
				this.report(session, "⚠️ VCに接続できなかったため、音楽を停止しました。");
				this.stop(session.guildId);
				if (session.connection.state.status !== VoiceConnectionStatus.Destroyed)
					session.connection.destroy();
				return;
			}
			const message = error instanceof Error ? error.message : "再生に失敗しました。";
			log.warn("Failed to start track", { message });
			this.report(session, `⚠️ ${message} 次の曲に進みます。`);
			this.finish(session, run);
		}
	}
}

export const musicService = new MusicService();
