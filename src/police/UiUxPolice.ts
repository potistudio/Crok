export const UI_UX_POLICE_MESSAGE = `🚨こちらは“UI/UX”警察です🚨　UIとUXは似て非なる概念であるため、スラッシュ区切りの表記は推奨されていません。UIが実体ある一つのモノであるのに対し、UXには実体がなく、それも一つとは限りません。人々それぞれに内在する感情や記憶などの「目に見えない何か」を体験と称します。また、ソフトウェアなどのUIの影響を受けずに形成される体験についてもしっかりと熟慮する必要があります。もしも二つを併記したい場合には、「UIとその体験」と書くと収まりが良くなります。ご検討をよろしくお願いいたします。`;

export function shouldPoliceUiUx(content: string): boolean {
	const regex = /(UI|UX)\s*[\/／・]\s*(UI|UX)/;
	return regex.test(content);
}
