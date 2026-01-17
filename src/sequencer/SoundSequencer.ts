import { Message } from "discord.js";
import {
	getVoiceConnection,
	createAudioPlayer,
	createAudioResource,
	StreamType,
} from "@discordjs/voice";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";

const SAMPLE_RATE: number = 44100;

const SOUND_MAP: { [key: string]: string } = {
	b: "se.wav",
	s: "se2.wav",
	o: "se3.wav",
	c: "se4.wav",
};

// Generate allowed characters string for Regex: e.g., "!\?/\-"
const ESCAPED_KEYS = Object.keys(SOUND_MAP)
	.map((k) => "\\" + k)
	.join("");
// Regex for simple notation: digits + (allowed keys or . ,)
const SIMPLE_REGEX = new RegExp(`^(\\d+)?([${ESCAPED_KEYS}.,]+)$`);

export class SoundSequencer {
	private soundPaths: { [key: string]: string };
	public useSynthesis: boolean = true;

	constructor() {
		this.soundPaths = {};
		for (const key in SOUND_MAP) {
			this.soundPaths[key] = join(__dirname, "../../assets/", SOUND_MAP[key]);
		}
	}

	public async processMessage(message: Message): Promise<void> {
		if (message.author.bot) return;
		if (!message.guild) return;

		// Sequence regex: anything containing brackets
		console.log("Processing message for sound sequencing:", message.content);
		if (message.content.includes("[") && message.content.includes("]")) {
			await this.handleSequence(message);
			return;
		}

		// Simple/Legacy regex: prefix BPM or just symbols
		// Dynamically generated from SOUND_MAP
		const match = message.content.match(SIMPLE_REGEX);
		if (match) {
			await this.handleSimple(message, match);
			return;
		}
	}

	private async handleSequence(message: Message): Promise<void> {
		if (!this.checkVoiceConnection(message)) return;

		const tracks = message.content.split("&&").map((t) => t.trim());
		const schedule: {
			delay: number;
			symbol: string;
			note?: number;
			octave?: number;
			isMidi?: boolean;
			duration?: number;
		}[] = [];
		let isMidiGlobal = false;

		for (const track of tracks) {
			// Check for MIDI mode flag 'M'
			// Regex: (BPM)? (M)? [Sequence]
			const midiMatch = track.match(/^(\d+)?\s*(M)?/);
			const isMidi = !!midiMatch?.[2];
			if (isMidi) isMidiGlobal = true;

			// Update regex to allow () and digits inside []
			// Also allow 'M' separated by space
			const matches = Array.from(track.matchAll(/(\d+)?\s*(M)?\s*\[([^\]]+)\]/g));
			if (matches.length === 0) continue;

			let currentTime = 0;

			for (const match of matches) {
				const bpmStr = match[1];
				const rawMarks = match[3];

				// Expand loops: 2(!!) -> !!!!
				const marksStr = this.expandLoops(rawMarks);

				let interval = 400; // default 150 BPM
				if (bpmStr) {
					const bpm = parseInt(bpmStr, 10);
					if (bpm > 0) {
						interval = 60000 / bpm;
					}
				}

				if (isMidi) {
					// MIDI Parsing: Look for "{", "}", "Note-Octave" or "." or ","
					const tokens = marksStr.match(/({|}|-?\d+-\d+|[.,])/g);
					if (!tokens) continue;

					let inChord = false;

					for (const token of tokens) {
						if (token === "{") {
							inChord = true;
						} else if (token === "}") {
							inChord = false;
							currentTime += interval;
						} else if (token === ".") {
							if (!inChord) currentTime += interval;
						} else if (token === ",") {
							if (!inChord) currentTime += interval / 2;
						} else {
							// Note-Octave
							const parts = token.split("-");
							if (parts.length === 2) {
								let note = parseInt(parts[0], 10);
								const octave = parseInt(parts[1], 10);

								// Force Note 0-11 range just in case
								note = note % 12;

								schedule.push({
									delay: currentTime,
									symbol: "sine",
									note,
									octave,
									isMidi: true,
									duration: interval,
								});
								if (!inChord) currentTime += interval;
							}
						}
					}
				} else {
					// Normal Sound Parsing
					const count = marksStr.length;
					for (let i = 0; i < count; i++) {
						const char = marksStr[i];
						if (char === ".") {
							currentTime += interval;
						} else if (char === ",") {
							currentTime += interval / 2;
						} else if (SOUND_MAP[char]) {
							schedule.push({ delay: currentTime, symbol: char });
							currentTime += interval;
						}
						// Ignore other characters
					}
				}
			}
		}

		if (schedule.length === 0) return;

		// Sort by delay
		schedule.sort((a, b) => a.delay - b.delay);

		this.playMixedSound(message, schedule);
	}

	private expandLoops(input: string): string {
		let result = input;
		const loopRegex = /(\d+)\(([^()]+)\)/;

		let match = result.match(loopRegex);
		while (match) {
			const count = parseInt(match[1], 10);
			const content = match[2];
			// Add space to prevent token merging (e.g. 0-40-4)
			const expanded = Array(count).fill(content).join(" ");

			// Replace the first match with expanded content
			result = result.replace(match[0], expanded);

			// Check again for nested or subsequent loops
			match = result.match(loopRegex);
		}
		return result;
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
		const schedule: { delay: number; symbol: string }[] = [];
		let currentTime = 0;

		for (let i = 0; i < count; i++) {
			const char = marks[i];
			if (char === ".") {
				currentTime += interval;
			} else if (char === ",") {
				currentTime += interval / 2;
			} else {
				schedule.push({ delay: currentTime, symbol: char });
				currentTime += interval;
			}
		}

		if (this.useSynthesis) {
			this.playMixedSound(message, schedule);
		} else {
			this.playSimpleSound(message, schedule);
		}
	}

	private playSimpleSound(message: Message, schedule: { delay: number; symbol: string }[]) {
		if (!message.guild) return;
		const connection = getVoiceConnection(message.guild.id);
		if (!connection) return;

		try {
			const player = createAudioPlayer();
			connection.subscribe(player);

			console.log(
				`Playing simple sequence (No synth) with ${schedule.length} notes for ${message.author.tag}`
			);

			schedule.forEach(({ delay, symbol }) => {
				const soundPath = this.soundPaths[symbol];
				if (!soundPath || !existsSync(soundPath)) {
					console.warn(`Sound file not found for symbol ${symbol}:`, soundPath);
					return;
				}

				setTimeout(() => {
					const resource = createAudioResource(soundPath);
					player.play(resource);
				}, delay);
			});
		} catch (error) {
			console.error("Failed to play simple sound sequence:", error);
		}
	}

	/**
	 * Calculate MIDI note number from note and octave
	 * @param note Note number (0-11)
	 * @param octave Octave number (e.g., 4 for middle C)
	 * @returns MIDI note number
	 */
	private calculateMidiNote(note: number, octave: number): number {
		return (octave + 1) * 12 + note;
	}

	private generateSineWave(note: number, octave: number, durationMs: number): Buffer {
		const midiNote = this.calculateMidiNote(note, octave);
		const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);
		const numChannels = 1; // Mono implies duplicating for Stereo mixer later or handling 1ch
		const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
		const buffer = Buffer.alloc(numSamples * 2); // 16-bit

		for (let i = 0; i < numSamples; i++) {
			const t = i / SAMPLE_RATE;
			const sample = Math.sin(2 * Math.PI * frequency * t);
			// Apply simple envelope (attack/release) to avoid clicking
			let amplitude = 0.5; // -6dB
			if (i < 500) amplitude *= i / 500; // 500 samples attack
			if (i > numSamples - 500) amplitude *= (numSamples - i) / 500; // 500 samples release

			const val16 = Math.floor(sample * amplitude * 32767);
			buffer.writeInt16LE(val16, i * 2);
		}

		return buffer;
	}

	private playMixedSound(
		message: Message,
		schedule: {
			delay: number;
			symbol: string;
			note?: number;
			octave?: number;
			isMidi?: boolean;
			duration?: number;
		}[]
	) {
		if (!message.guild) return;
		const connection = getVoiceConnection(message.guild.id);
		if (!connection) return;

		try {
			// Pre-load all required audio buffers
			const loadedBuffers: {
				[key: string]: {
					buffer: Buffer;
					sampleRate: number;
					numChannels: number;
					bitsPerSample: number;
				};
			} = {};

			// Load unique symbols (WAV files)
			const uniqueSymbols = Array.from(
				new Set(schedule.filter((s) => !s.isMidi).map((s) => s.symbol))
			);

			for (const symbol of uniqueSymbols) {
				const soundPath = this.soundPaths[symbol];
				if (!soundPath || !existsSync(soundPath)) {
					console.warn(`Sound file not found for symbol ${symbol}:`, soundPath);
					continue;
				}

				const wavBuffer = readFileSync(soundPath);

				// ... existing loading logic ...
				// I'll reuse the existing logic carefully by copying it back or simplifying
				// Since I'm replacing the whole playMixedSound, I need to include the loading logic again.

				// Find 'fmt ' chunk
				let fmtOffset = 12;
				let foundFmt = false;
				while (fmtOffset < wavBuffer.length) {
					const chunkId = wavBuffer.toString("utf8", fmtOffset, fmtOffset + 4);
					const chunkSize = wavBuffer.readUInt32LE(fmtOffset + 4);
					if (chunkId === "fmt ") {
						foundFmt = true;
						break;
					}
					fmtOffset += 8 + chunkSize + (chunkSize % 2);
				}

				if (!foundFmt) continue;

				const audioFormat = wavBuffer.readUInt16LE(fmtOffset + 8);
				const numChannels = wavBuffer.readUInt16LE(fmtOffset + 8 + 2);
				const sampleRate = wavBuffer.readUInt32LE(fmtOffset + 8 + 4);
				const bitsPerSample = wavBuffer.readUInt16LE(fmtOffset + 8 + 14);

				// Find 'data' chunk
				let dataOffset = 12;
				let foundData = false;
				while (dataOffset < wavBuffer.length) {
					const chunkId = wavBuffer.toString("utf8", dataOffset, dataOffset + 4);
					const chunkSize = wavBuffer.readUInt32LE(dataOffset + 4);
					if (chunkId === "data") {
						foundData = true;
						break;
					}
					dataOffset += 8 + chunkSize + (chunkSize % 2);
				}
				if (!foundData) continue;

				const dataSize = wavBuffer.readUInt32LE(dataOffset + 4);
				const rawAudioData = wavBuffer.subarray(dataOffset + 8, dataOffset + 8 + dataSize);
				const normalizedData = this.normalizeTo16Bit(
					rawAudioData,
					audioFormat,
					bitsPerSample
				);

				if (normalizedData) {
					loadedBuffers[symbol] = {
						buffer: normalizedData,
						sampleRate,
						numChannels,
						bitsPerSample: 16,
					};
				}
			}

			// Generate MIDI buffers
			// We need to generate a buffer for each Note event.
			// Ideally we cache them if repeated? Or just generate.
			// Duration? For now hardcoded or derived from Schedule?
			// The Schedule determines *Start Time*. The duration is not explicitly stored in schedule yet for normal sounds.
			// But for MIDI we need duration.
			// In handleSequence, we increment currentTime by interval. So duration ~= interval.
			// However, schedule currently only has start time.
			// Let's assume duration = 200ms or 400ms (based on bpm?)
			// I'll update schedule generation to include duration or use a default.
			// Actually, to make it sound musical, duration should equal the interval (minus small gap?).

			// Hack: We don't have interval in playMixedSound.
			// We can infer it or just use a standard length (e.g. 200ms).
			// But wait, user wants `120M`. 120BPM = 500ms / beat.
			// I should probably store duration in schedule.

			// Master format defaults
			let masterRate = 44100;
			let masterChannels = 2; // Default to Stereo

			// If we have WAVs, prefer their format?
			const wavKey = Object.keys(loadedBuffers)[0];
			if (wavKey) {
				masterRate = loadedBuffers[wavKey].sampleRate;
				masterChannels = loadedBuffers[wavKey].numChannels;
			}

			// Calculate total duration
			const bytesPerMs = (masterRate * masterChannels * 2) / 1000;
			const blockAlign = masterChannels * 2;

			let maxDurationMs = 0;
			for (const note of schedule) {
				let durationMs = 0;
				if (note.isMidi) {
					durationMs = 500; // Default for now if not in schedule
					// Actually, let's look at note.delay of next event? No, parallel tracks make that hard.
					// I'll add duration to schedule in handleSequence.
				} else {
					const buf = loadedBuffers[note.symbol];
					if (buf) {
						durationMs =
							(buf.buffer.length / (buf.sampleRate * buf.numChannels * 2)) * 1000;
					}
				}
				const endMs = note.delay + durationMs;
				if (endMs > maxDurationMs) maxDurationMs = endMs;
			}

			const totalBufferBytes = Math.ceil((maxDurationMs + 100) * bytesPerMs);
			const alignedTotalBytes = Math.ceil(totalBufferBytes / blockAlign) * blockAlign;
			// Mix using Float32 to avoid clipping during accumulation
			const numSamples = Math.floor(alignedTotalBytes / 2);
			const mixBuffer = new Float32Array(numSamples);

			let clipsMixed = 0;
			for (const note of schedule) {
				let srcBuffer: Buffer;
				let srcRate = 44100;
				let srcChannels = 1;

				if (note.isMidi && note.note !== undefined && note.octave !== undefined) {
					// Generate on the fly - use BPM-based duration
					const dur = note.duration ?? 400;
					srcBuffer = this.generateSineWave(note.note, note.octave, dur);
					srcRate = 44100;
					srcChannels = 1;
				} else {
					const buf = loadedBuffers[note.symbol];
					if (!buf) continue;
					srcBuffer = buf.buffer;
					srcRate = buf.sampleRate;
					srcChannels = buf.numChannels;
				}

				const offsetMs = note.delay;
				const startSample = Math.floor((offsetMs * masterRate * masterChannels) / 1000);
				// Ensure stereo alignment
				const alignedStartSample = startSample - (startSample % masterChannels);

				for (let i = 0; i < srcBuffer.length; i += 2) {
					const sample16 = srcBuffer.readInt16LE(i);
					const sampleFloat = sample16 / 32768.0;

					const destIndex =
						alignedStartSample +
						(i / 2) * (srcChannels === 1 && masterChannels === 2 ? 2 : 1);

					if (masterChannels === 2) {
						if (srcChannels === 1) {
							// Mono to Stereo
							if (destIndex < mixBuffer.length) mixBuffer[destIndex] += sampleFloat;
							if (destIndex + 1 < mixBuffer.length)
								mixBuffer[destIndex + 1] += sampleFloat;
						} else {
							// Stereo to Stereo
							if (destIndex < mixBuffer.length) mixBuffer[destIndex] += sampleFloat;
						}
					} else {
						// Mono Master
						if (destIndex < mixBuffer.length) mixBuffer[destIndex] += sampleFloat;
					}
				}
				clipsMixed++;
			}
			console.log(`[DEBUG] Mixed ${clipsMixed} clips.`);

			// Normalize if peak exceeds 1.0 (soft limiter)
			let maxPeak = 0;
			for (let i = 0; i < mixBuffer.length; i++) {
				const abs = Math.abs(mixBuffer[i]);
				if (abs > maxPeak) maxPeak = abs;
			}

			let gain = 1.0;
			if (maxPeak > 0.95) {
				gain = 0.95 / maxPeak;
				console.log(
					`[DEBUG] Limiting gain: ${(gain * 100).toFixed(1)}% (Peak: ${maxPeak.toFixed(2)})`
				);
			}

			// Convert back to Int16
			const outputBuffer = Buffer.alloc(alignedTotalBytes);
			for (let i = 0; i < mixBuffer.length; i++) {
				let val = mixBuffer[i] * gain;
				val = Math.max(-1, Math.min(1, val));
				outputBuffer.writeInt16LE(Math.floor(val * 32767), i * 2);
			}

			// Output Header & Write
			const header = Buffer.alloc(44);
			header.write("RIFF", 0);
			header.writeUInt32LE(36 + outputBuffer.length, 4);
			header.write("WAVE", 8);
			header.write("fmt ", 12);
			header.writeUInt32LE(16, 16);
			header.writeUInt16LE(1, 20); // PCM
			header.writeUInt16LE(masterChannels, 22);
			header.writeUInt32LE(masterRate, 24);
			header.writeUInt32LE(masterRate * blockAlign, 28); // ByteRate
			header.writeUInt16LE(blockAlign, 32);
			header.writeUInt16LE(16, 34); // BitsPerSample
			header.write("data", 36);
			header.writeUInt32LE(outputBuffer.length, 40);

			const finalBuffer = Buffer.concat([header, outputBuffer]);
			const tempPath = join(tmpdir(), `crok_${Date.now()}.wav`);
			writeFileSync(tempPath, finalBuffer);

			const player = createAudioPlayer();
			const resource = createAudioResource(tempPath);
			connection.subscribe(player);
			player.play(resource);

			setTimeout(() => {
				try {
					unlinkSync(tempPath);
				} catch (e) {}
			}, maxDurationMs + 5000);
		} catch (error) {
			console.error("Failed to play sound sequence:", error);
		}
	}

	private normalizeTo16Bit(
		buffer: Buffer,
		audioFormat: number,
		bitsPerSample: number
	): Buffer | null {
		// Output is always 16-bit PCM
		if (audioFormat === 1 && bitsPerSample === 16) {
			return buffer; // Already 16-bit PCM
		}

		console.log(
			`[DEBUG] Normalizing from Format=${audioFormat}, Bits=${bitsPerSample} to 16-bit PCM`
		);

		try {
			// 8-bit PCM (unsigned)
			if (audioFormat === 1 && bitsPerSample === 8) {
				const newBuffer = Buffer.alloc(buffer.length * 2);
				for (let i = 0; i < buffer.length; i++) {
					const val = buffer.readUInt8(i); // 0-255
					const val16 = (val - 128) * 256;
					newBuffer.writeInt16LE(val16, i * 2);
				}
				return newBuffer;
			}

			// 24-bit PCM (signed)
			if (audioFormat === 1 && bitsPerSample === 24) {
				const numSamples = buffer.length / 3;
				const newBuffer = Buffer.alloc(numSamples * 2);
				for (let i = 0; i < numSamples; i++) {
					const b0 = buffer[i * 3];
					const b1 = buffer[i * 3 + 1];
					const b2 = buffer[i * 3 + 2];
					let val = (b2 << 16) | (b1 << 8) | b0;
					if (val & 0x800000) val |= 0xff000000; // Sign extend if negative
					const val16 = val >> 8;
					newBuffer.writeInt16LE(val16, i * 2);
				}
				return newBuffer;
			}

			// 32-bit Float (IEEE 754)
			if (audioFormat === 3 && bitsPerSample === 32) {
				const numSamples = buffer.length / 4;
				const newBuffer = Buffer.alloc(numSamples * 2);
				for (let i = 0; i < numSamples; i++) {
					const val = buffer.readFloatLE(i * 4);
					const clamped = Math.max(-1, Math.min(1, val));
					const val16 = Math.floor(clamped * 32767);
					newBuffer.writeInt16LE(val16, i * 2);
				}
				return newBuffer;
			}

			// 32-bit Int (PCM)
			if (audioFormat === 1 && bitsPerSample === 32) {
				const numSamples = buffer.length / 4;
				const newBuffer = Buffer.alloc(numSamples * 2);
				for (let i = 0; i < numSamples; i++) {
					const val = buffer.readInt32LE(i * 4);
					const val16 = val >> 16;
					newBuffer.writeInt16LE(val16, i * 2);
				}
				return newBuffer;
			}

			console.warn(`[WARN] Unsupported format: Format=${audioFormat}, Bits=${bitsPerSample}`);
			return null;
		} catch (e) {
			console.error("Normalization error:", e);
			return null;
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
