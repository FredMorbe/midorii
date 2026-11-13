/**
 * The bytes of an image, as the journal handles them.
 *
 * A snapshot leaves the chart as a data URL and has to reach the store as bytes; an image coming
 * back from the store has to be shown. Both directions live here so there is one reading of
 * what a data URL is.
 */

/**
 * What went wrong, as a person should read it.
 *
 * A refusal that crossed the bridge arrives wrapped in "Error invoking remote method '…': Error:",
 * which says where it travelled and nothing about what happened. The reason is what follows it.
 */
export function readableError(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return text.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** The bytes inside a `data:image/…;base64,…` URL. Throws on anything else. */
export function dataUrlBytes(url: string): Uint8Array {
    const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new Error('This is not an inline PNG or JPEG image.');
    const binary = atob(match[1]!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** A URL an `<img>` can show the stored bytes from. The caller revokes it when done. */
export function imageObjectUrl(shot: { type: 'png' | 'jpeg'; data: Uint8Array }): string {
    return URL.createObjectURL(new Blob([shot.data as BlobPart], { type: `image/${shot.type}` }));
}

/** What a picked or pasted file holds. */
export async function fileBytes(file: Blob): Promise<Uint8Array> {
    return new Uint8Array(await file.arrayBuffer());
}
