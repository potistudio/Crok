import { describe, expect, it } from "vitest";
import { normalizeTrackUrl } from "./AudioSource";

describe("music URL validation", () => {
	it.each([
		"https://youtu.be/jNQXAC9IVRw?t=5",
		"https://www.youtube.com/watch?v=jNQXAC9IVRw&list=some-list",
		"https://music.youtube.com/watch?v=jNQXAC9IVRw",
		"https://m.youtube.com/shorts/jNQXAC9IVRw",
		"https://youtube.com/live/jNQXAC9IVRw",
	])("normalizes a single YouTube video: %s", (url) => {
		expect(normalizeTrackUrl(url)).toBe("https://www.youtube.com/watch?v=jNQXAC9IVRw");
	});
	it.each([
		"https://soundcloud.com/artist/track",
		"https://soundcloud.com/artist/track/s-secret",
		"https://on.soundcloud.com/ABC123",
		"https://snd.sc/ABC123",
	])("accepts SoundCloud tracks and official share links: %s", (url) => {
		expect(normalizeTrackUrl(url)).toBe(url);
	});
	it.each([
		"ytsearch:test",
		"file:///etc/passwd",
		"http://127.0.0.1/song",
		"--exec=bad",
		"https://youtube.com.evil.example/watch?v=jNQXAC9IVRw",
		"https://soundcloud.com@evil.example/artist/song",
		"https://user:password@soundcloud.com/artist/song",
		"https://soundcloud.com:8080/artist/song",
		"https://www.youtube.com/playlist?list=123",
		"https://youtu.be/not-an-id",
		"https://soundcloud.com/artist",
		"https://soundcloud.com/artist/sets/album",
		"https://soundcloud.com/artist/likes",
	])("rejects unsupported inputs: %s", (url) => {
		expect(() => normalizeTrackUrl(url)).toThrow();
	});
});
