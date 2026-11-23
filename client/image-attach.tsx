// Pasted images, the one component and model for every field whose words reach an agent
// (every-agent-field-takes-images, docs/client.md#pasted-images): New's task and note, the Overseer's reply box, Home's
// search when it asks the Overseer, More context, a question's answer and note, the brief card's answer and note, and
// Catch up's fields (which reuse QuestionBody and MorePanel). Desktop web takes a paste into the field or a drop on it;
// each image shows as a small thumbnail with a remove ×. Past a cap it refuses up front with the reason (invariant 8),
// and a recipient that can't take images says so on the field before Send (follow.image-support). Phones: the plugin
// client has no image picker for plugin fields, so nothing is drawn there and no space is kept.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "./text";
import { text, type Theme } from "./kit";
import { withAlpha } from "./theme";
import { imageSupportRpc } from "../shared/contracts";
import { ImageViewer, refocus, viewerInline, type ViewedImage } from "./image-viewer";
import { imageRefusal, imageTargetKey, mb, type ImageSupport, type ImageTarget, type ImageUpload } from "../shared/images";

export const IMAGES_ON = Platform.OS === "web";

export type AttachedImage = { id: string; name: string; mimeType: string; bytes: number; data: string; uri: string };
/** What a paste or drop hands the model: enough to refuse before reading, and how to read it. */
export type IncomingImage = { name: string; mimeType: string; bytes: number; read(): Promise<string> };

export type ImageAttachments = {
  images: AttachedImage[];
  /** The last refusal (a cap, a type), shown under the thumbnails until the next add or remove. */
  refusal: string | null;
  /** Set while images are attached and the recipient can't take them: the field shows it and Send is disabled. */
  blocked: string | null;
  add(incoming: IncomingImage[]): Promise<void>;
  remove(id: string): void;
  clear(): void;
  /** The RPC field: undefined with no images, so nothing changes for a send without them. */
  uploads(): ImageUpload[] | undefined;
  /** The recipient changed (New's agent pick): the support line is asked again for it. */
  target: ImageTarget | null;
};

/** One answer per recipient per client: asked when the first image is added, never on a timer. */
const supportCache = new Map<string, Promise<ImageSupport>>();
let seq = 0;

/**
 * The field's model. `target`: who the words go to (an agent, a workspace's main agent, the Overseer, New's provider);
 * null leaves support unknown, which never blocks (the server still refuses an image it can't keep).
 */
export function useImageAttachments({ target }: { target: ImageTarget | null }): ImageAttachments {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Keyed by the target it answers, so a new pick (New's agent) never shows the last one's answer.
  const [support, setSupport] = useState<{ key: string; s: ImageSupport } | null>(null);
  const ask = useRpc(imageSupportRpc);
  const key = target ? imageTargetKey(target) : null;
  const current = useRef(images); current.current = images;
  useEffect(() => {
    if (!key || !target || !images.length) return;
    let live = true;
    let p = supportCache.get(key);
    if (!p) { p = ask({ target }).catch(() => ({ ok: true, provider: null, reason: null })); supportCache.set(key, p); }
    void p.then(s => { if (live) setSupport({ key, s }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, images.length > 0]);
  const add = useCallback(async (incoming: IncomingImage[]) => {
    if (!incoming.length) return;
    const why = imageRefusal(current.current, incoming);
    if (why) { setRefusal(why); return; }
    setRefusal(null);
    const read: AttachedImage[] = [];
    for (const i of incoming) {
      try { const data = await i.read(); read.push({ id: `img${++seq}`, name: i.name, mimeType: i.mimeType, bytes: i.bytes, data, uri: `data:${i.mimeType};base64,${data}` }); }
      catch { setRefusal(`${i.name} couldn't be read.`); return; }
    }
    // Checked again against what's there now (two pastes in a row).
    const again = imageRefusal(current.current, read);
    if (again) { setRefusal(again); return; }
    setImages(list => [...list, ...read]);
  }, []);
  const remove = useCallback((id: string) => { setRefusal(null); setImages(list => list.filter(i => i.id !== id)); }, []);
  const clear = useCallback(() => { setRefusal(null); setImages([]); }, []);
  const ready = support && support.key === key ? support.s : null;
  const blocked = images.length && ready && !ready.ok ? ready.reason : null;
  return useMemo(() => ({
    images, refusal, blocked, add, remove, clear, target,
    uploads: () => images.length ? images.map(i => ({ name: i.name, mimeType: i.mimeType as ImageUpload["mimeType"], data: i.data })) : undefined,
  }), [images, refusal, blocked, add, remove, clear, target]);
}

/** Image items of a paste's clipboardData or a drop's dataTransfer, as the model takes them. */
export function incomingFrom(data: { items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>; files?: ArrayLike<File> } | null | undefined): IncomingImage[] {
  if (!data) return [];
  const files: File[] = [];
  if (data.items?.length) for (const item of Array.from(data.items)) { if (item.kind === "file" && item.type.startsWith("image/")) { const f = item.getAsFile(); if (f) files.push(f); } }
  else if (data.files?.length) for (const f of Array.from(data.files)) if (f.type.startsWith("image/")) files.push(f);
  return files.map((f, i) => ({ name: f.name && f.name !== "image.png" ? f.name : `Pasted image${files.length > 1 ? ` ${i + 1}` : ""}`, mimeType: f.type, bytes: f.size, read: () => readBase64(f) }));
}
function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result ?? ""); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

type DomEl = { addEventListener(t: string, f: (e: never) => void): void; removeEventListener(t: string, f: (e: never) => void): void };
type DragEvt = { dataTransfer?: { types?: ArrayLike<string>; dropEffect?: string } & Parameters<typeof incomingFrom>[0]; preventDefault(): void; relatedTarget?: unknown; currentTarget?: { contains?(n: unknown): boolean } };
type PasteEvt = { clipboardData?: (Parameters<typeof incomingFrom>[0] & { getData?(t: string): string }) | null; preventDefault(): void };

/**
 * Web: a paste into anything inside `ref` (the field's wrapper; the field's own paste bubbles up to it) and a drop on
 * it add the images. A paste that is only images doesn't paste a file name as text. Returns whether a drag is over it.
 */
export function useImagePaste(ref: { current: unknown }, model: ImageAttachments): boolean {
  const [over, setOver] = useState(false);
  const add = model.add;
  useEffect(() => {
    if (!IMAGES_ON) return;
    const el = ref.current as DomEl | null;
    if (!el?.addEventListener) return;
    const hasFiles = (e: DragEvt) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const paste = (e: PasteEvt) => {
      const incoming = incomingFrom(e.clipboardData);
      if (!incoming.length) return;
      if (!e.clipboardData?.getData?.("text/plain")) e.preventDefault();
      void add(incoming);
    };
    const dragover = (e: DragEvt) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; setOver(true); };
    const dragleave = (e: DragEvt) => { if (e.currentTarget?.contains?.(e.relatedTarget)) return; setOver(false); };
    const drop = (e: DragEvt) => { if (!hasFiles(e)) return; e.preventDefault(); setOver(false); void add(incomingFrom(e.dataTransfer)); };
    el.addEventListener("paste", paste as never); el.addEventListener("dragover", dragover as never); el.addEventListener("dragleave", dragleave as never); el.addEventListener("drop", drop as never);
    return () => { el.removeEventListener("paste", paste as never); el.removeEventListener("dragover", dragover as never); el.removeEventListener("dragleave", dragleave as never); el.removeEventListener("drop", drop as never); };
  }, [ref, add]);
  return over;
}

/**
 * The field with its images: wraps the field (paste and drop land on it), then draws the thumbnails, the refusal and
 * the support line under it. Native: the field alone, nothing else and no space.
 */
export function ImageField({ model, theme, compact = false, children, style, row = true }: { model: ImageAttachments; theme: Pick<Theme, "colors">; compact?: boolean; children: ReactNode; style?: StyleProp<ViewStyle>;
  /** False: takes pastes and drops only; another field of the same model draws the thumbnails (New's note on desktop). */
  row?: boolean }) {
  const ref = useRef<View>(null);
  const over = useImagePaste(ref, model);
  if (!IMAGES_ON) return <View style={style}>{children}</View>;
  const c = theme.colors;
  return <View ref={ref} style={[{ gap: 6 }, style]}>
    <View style={over ? { borderRadius: 8, outlineStyle: "dashed", outlineWidth: 2, outlineColor: c.accent, outlineOffset: 2 } as ViewStyle : undefined}>{children}</View>
    {row && <ImageAttachmentsRow model={model} theme={theme} compact={compact} />}
  </View>;
}

/**
 * The thumbnails with their ×, the refusal and the support line. Draws nothing when there is nothing to say. A click on
 * a thumbnail shows it larger in the release notes' viewer (image-viewer.tsx), so the right screenshot is checked
 * before Send.
 */
export function ImageAttachmentsRow({ model, theme, compact = false }: { model: ImageAttachments; theme: Pick<Theme, "colors">; compact?: boolean }) {
  const [viewed, setViewed] = useState<{ image: ViewedImage; from: unknown } | null>(null);
  if (!IMAGES_ON) return null;
  const c = theme.colors; const t = text(c, compact);
  const { images, refusal, blocked } = model;
  if (!images.length && !refusal) return null;
  const view = (i: AttachedImage, from: unknown) => {
    const label = `${i.name}, ${mb(i.bytes)}`;
    Image.getSize(i.uri, (w, h) => setViewed({ image: { url: i.uri, label, width: w, aspect: w / Math.max(1, h) }, from }), () => setViewed({ image: { url: i.uri, label, width: null, aspect: 16 / 10 }, from }));
  };
  const size = compact ? 56 : 48;
  return <View style={{ gap: 6 }}>
    {!!images.length && <View role="list" accessibilityLabel={`${images.length} image${images.length === 1 ? "" : "s"} attached`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, paddingTop: 6, paddingRight: 6 }}>
      {images.map(i => <View key={i.id} role="listitem" style={{ width: size, height: size }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`View ${i.name}, ${mb(i.bytes)}`} onPress={e => view(i, e?.currentTarget)} {...({ title: `${i.name} · ${mb(i.bytes)}` } as object)}>
          <Image source={{ uri: i.uri }} accessibilityIgnoresInvertColors resizeMode="cover"
            style={{ width: size, height: size, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${i.name}`} onPress={() => model.remove(i.id)} hitSlop={compact ? 10 : 6}
          style={(state) => { const { hovered, focused } = state as { hovered?: boolean; focused?: boolean }; return { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center",
            backgroundColor: hovered || focused ? c.foreground : withAlpha(c.foreground, 0.85), borderWidth: 1, borderColor: c.surface0 }; }}>
          <Icon name="X" size={12} color={c.surface0} />
        </Pressable>
      </View>)}
    </View>}
    {/* A refusal adds nothing of what was pasted (the whole paste is refused), so it says so. */}
    {!!(refusal || blocked) && <Text accessibilityRole="alert" style={[t.meta, { color: blocked ? c.statusDanger : c.statusWarning }]}>{refusal ? `${refusal} Nothing was added.` : blocked}</Text>}
    {viewed && <ImageViewer image={viewed.image} inline={viewerInline(compact)} onClose={() => { const from = viewed.from; setViewed(null); refocus(from); }} />}
  </View>;
}
