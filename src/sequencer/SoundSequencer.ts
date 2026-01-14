import { Message } from 'discord.js';
import { getVoiceConnection, createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

const SAMPLE_NAME = 'se.wav';

export class SoundSequencer {
	private soundPath: string;

	constructor() {
		this.soundPath = join(__dirname, '../../assets/', SAMPLE_NAME); // readjusted path from src/sound/
	}

	public async processMessage(message: Message): Promise<void> {
		if (message.author.bot) return;
		if (!message.guild) return;

		// Sequence regex: anything containing brackets
		console.log('Processing message for sound sequencing:', message.content);
		if (message.content.includes('[') && message.content.includes(']')) {
			await this.handleSequence(message);
			return;
		}

		// Simple/Legacy regex: prefix BPM or just exclamation marks
		const match = message.content.match(/^(\d+)?(!+)$/);
		if (match) {
			await this.handleSimple(message, match);
			return;
		}
	}

	private async handleSequence(message: Message): Promise<void> {
		if (!this.checkVoiceConnection(message)) return;

		const parts = message.content.split(',');
		const schedule: { delay: number }[] = [];
		let currentTime = 0;

		for (const part of parts) {
			const match = part.trim().match(/^(\d+)?\[(!+)\]$/);
			if (!match) continue;

			const bpmStr = match[1];
			const marks = match[2];

			let interval = 400; // default 150 BPM
			if (bpmStr) {
				const bpm = parseInt(bpmStr, 10);
				if (bpm > 0) {
					interval = 60000 / bpm;
				}
			}

			const count = marks.length;
			for (let i = 0; i < count; i++) {
				schedule.push({ delay: currentTime });
				currentTime += interval;
			}
		}

		if (schedule.length === 0) return;

		this.playMixedSound(message, schedule);
	}

	private async handleSimple(message: Message, match: RegExpMatchArray): Promise<void> {
		if (!this.checkVoiceConnection(message)) return;

		const bpmStr = match[1];
		const marks = match[2];

		let interval = 400; // default 150 BPM
		if (bpmStr) {
			const bpm = parseInt(bpmStr, 10);
			if (bpm > 0) {
				interval = 60000 / bpm;
			}
		}

		const count = marks.length;
		const schedule: { delay: number }[] = [];

		for (let i = 0; i < count; i++) {
			schedule.push({ delay: i * interval });
		}

		this.playMixedSound(message, schedule);
	}

	private playMixedSound(message: Message, schedule: { delay: number }[]) {
		if (!message.guild) return;
		const connection = getVoiceConnection(message.guild.id);
		if (!connection) return;

		try {
			if (!existsSync(this.soundPath)) {
				console.warn('Sound file not found:', this.soundPath);
				return;
			}

			// Read the source WAV file
			const wavBuffer = readFileSync(this.soundPath);
			console.log(`[DEBUG] Read WAV file: ${this.soundPath}, size: ${wavBuffer.length}`);

			// Basic WAV Validation and Header Parsing
			// RIFF header (0-3: 'RIFF', 8-11: 'WAVE')
			if (wavBuffer.toString('utf8', 0, 4) !== 'RIFF' || wavBuffer.toString('utf8', 8, 12) !== 'WAVE') {
				console.error('Invalid WAV file');
				return;
			}

			// Find 'fmt ' chunk
			let fmtOffset = 12;
			let foundFmt = false;
			while (fmtOffset < wavBuffer.length) {
				const chunkId = wavBuffer.toString('utf8', fmtOffset, fmtOffset + 4);
				const chunkSize = wavBuffer.readUInt32LE(fmtOffset + 4);
				if (chunkId === 'fmt ') {
					foundFmt = true;
					break;
				}
				fmtOffset += 8 + chunkSize;
			}

			if (!foundFmt) {
				console.error('[DEBUG] fmt chunk not found');
				return;
			}

			// Parse fmt chunk
			// offset + 8 is where chunk data starts
			const numChannels = wavBuffer.readUInt16LE(fmtOffset + 8 + 2);
			const sampleRate = wavBuffer.readUInt32LE(fmtOffset + 8 + 4);
			const byteRate = wavBuffer.readUInt32LE(fmtOffset + 8 + 8);
			const blockAlign = wavBuffer.readUInt16LE(fmtOffset + 8 + 12);
			const bitsPerSample = wavBuffer.readUInt16LE(fmtOffset + 8 + 14);

			console.log(`[DEBUG] FMT: Channels=${numChannels}, SampleRate=${sampleRate}, ByteRate=${byteRate}, BlockAlign=${blockAlign}, Bits=${bitsPerSample}`);

			if (bitsPerSample !== 16) {
				console.warn('Only 16-bit WAV is currently supported for mixing.');
			}

			// Validate byteRate to avoid Infinity/NaN
			let effectiveByteRate = byteRate;
			if (!effectiveByteRate || effectiveByteRate === 0) {
				effectiveByteRate = sampleRate * numChannels * (bitsPerSample / 8);
				console.log(`[DEBUG] Recalculated ByteRate: ${effectiveByteRate}`);
			}

			// Find 'data' chunk
			let dataOffset = 12; // Start after RIFF header
			let foundData = false;

			console.log(`[DEBUG] Parsing WAV file. Total size: ${wavBuffer.length}`);

			while (dataOffset < wavBuffer.length) {
				const chunkId = wavBuffer.toString('utf8', dataOffset, dataOffset + 4);
				const chunkSize = wavBuffer.readUInt32LE(dataOffset + 4);

				console.log(`[DEBUG] Found chunk: '${chunkId}' size: ${chunkSize} at offset: ${dataOffset}`);

				if (chunkId === 'data') {
					foundData = true;
					break;
				}
				dataOffset += 8 + chunkSize;
			}

			if (!foundData) {
				console.error('[DEBUG] Data chunk not found in WAV file.');
				return;
			}

			const dataSize = wavBuffer.readUInt32LE(dataOffset + 4);
			console.log(`[DEBUG] Data chunk size: ${dataSize}`);
			const audioData = wavBuffer.subarray(dataOffset + 8, dataOffset + 8 + dataSize);

			// Calculate total duration in bytes
			const bytesPerMs = effectiveByteRate / 1000;
			const lastNoteDelay = schedule[schedule.length - 1].delay;
			const soundDurationMs = (dataSize / effectiveByteRate) * 1000;
			const totalDurationMs = lastNoteDelay + soundDurationMs + 100; // +100ms margin
			const totalBufferBytes = Math.ceil(totalDurationMs * bytesPerMs);

			console.log(`[DEBUG] Mixing audio. Total duration: ${totalDurationMs.toFixed(2)}ms, Buffer size: ${totalBufferBytes}`);

			// Align to blockAlign
			const alignedTotalBytes = Math.ceil(totalBufferBytes / blockAlign) * blockAlign;

			// Create output buffer (filled with 0)
			const outputBuffer = Buffer.alloc(alignedTotalBytes);

			// Mix down
			let clipsMixed = 0;
			for (const note of schedule) {
				const offsetMs = note.delay;
				const startByte = Math.floor(offsetMs * bytesPerMs);
				// Align startByte
				const alignedStartByte = Math.floor(startByte / blockAlign) * blockAlign;

				for (let i = 0; i < audioData.length; i += 2) { // 16-bit step
					const destIndex = alignedStartByte + i;
					if (destIndex + 1 >= outputBuffer.length) break;

					const existingSample = outputBuffer.readInt16LE(destIndex);
					const newSample = audioData.readInt16LE(i);

					// Mix and clamp
					let mixed = existingSample + newSample;
					if (mixed > 32767) mixed = 32767;
					if (mixed < -32768) mixed = -32768;

					outputBuffer.writeInt16LE(mixed, destIndex);
				}
				clipsMixed++;
			}
			console.log(`[DEBUG] Mixed ${clipsMixed} clips.`);

			// Reconstruct WAV Header for the output
			// We can just copy the header from original and update sizes
			// But careful if the original header had extra chunks that we skipped
			// A minimal WAV header is 44 bytes (RIFF(4) + Size(4) + WAVE(4) + fmt (4) + Size(4) + Format(16) + data(4) + Size(4))
			// However we want to preserve the format of the input file.
			// Let's create a clean header based on the parsed fmt chunk.

			const newHeader = Buffer.alloc(44);
			newHeader.write('RIFF', 0);
			newHeader.writeUInt32LE(36 + outputBuffer.length, 4);
			newHeader.write('WAVE', 8);
			newHeader.write('fmt ', 12);
			newHeader.writeUInt32LE(16, 16); // fmt chunk size
			newHeader.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
			newHeader.writeUInt16LE(numChannels, 22);
			newHeader.writeUInt32LE(sampleRate, 24);
			newHeader.writeUInt32LE(effectiveByteRate, 28);
			newHeader.writeUInt16LE(blockAlign, 32);
			newHeader.writeUInt16LE(bitsPerSample, 34);
			newHeader.write('data', 36);
			newHeader.writeUInt32LE(outputBuffer.length, 40);

			const finalBuffer = Buffer.concat([newHeader, outputBuffer]);

			// Write to temp file to ensure correct playback
			const tempPath = join(tmpdir(), `crok_${Date.now()}.wav`);
			writeFileSync(tempPath, finalBuffer);
			console.log(`[DEBUG] Wrote temp WAV to: ${tempPath}`);

			const player = createAudioPlayer();
			const resource = createAudioResource(tempPath);

			connection.subscribe(player);
			player.play(resource);

			console.log(`Played mixed sequence with ${schedule.length} notes for ${message.author.tag}`);

			// Clean up temp file after a delay
			setTimeout(() => {
				try {
					unlinkSync(tempPath);
				} catch (e) {
					// Ignore cleanup errors
				}
			}, totalDurationMs + 5000);

		} catch (error) {
			console.error('Failed to play sound sequence:', error);
		}
	}

	private checkVoiceConnection(message: Message): boolean {
		if (!message.guild) return false;

		const connection = getVoiceConnection(message.guild.id);
		if (!connection) return false;

		const member = message.member;
		if (!member?.voice.channelId) return false;
		if (connection.joinConfig.channelId !== member.voice.channelId) return false;

		return true;
	}
}

export const soundSequencer = new SoundSequencer();
