/** Local-only live Storage regression. No production configuration is loaded. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { uploadResumable, signedResumableTarget, RESUMABLE_CHUNK_BYTES } from '../../ugc-mobile/lib/media-upload/resumable';
import { readPostMedia } from '../../src/lib/post-media-read-service';
import { processUploadedMediaMaintenance } from '../../src/lib/uploaded-media-maintenance';

async function verify() {
  const configuration = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const url = configuration.API_URL;
  if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('This probe only runs against local Supabase');
  const admin = createClient(url, configuration.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const owner = await admin.auth.admin.createUser({ email: `media-${randomUUID()}@example.invalid`, password: randomUUID(), email_confirm: true });
  if (owner.error || !owner.data.user) throw new Error('Fixture identity failed');
  const ownerId = owner.data.user.id;
  const postId = randomUUID();
  const publicPath = `posts/${postId}/video.mp4`;
  const privatePath = `private-${publicPath}`;
  const uploadPath = `${ownerId}/${randomUUID()}.mp4`;
  // Deterministic >6MB file so recovery must span more than one chunk.
  const bytes = Buffer.alloc(RESUMABLE_CHUNK_BYTES + 131_072, 0x5a);
  const checksum = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const sql = (query: string) => execFileSync('docker', ['exec', '-i', 'supabase_db_magicbooklet', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: query, stdio: ['pipe', 'pipe', 'pipe'] });
  const checked = <T extends { error: unknown }>(result: T): T => { if (result.error) throw result.error; return result; };
  try {
    const signed = checked(await admin.storage.from('uploads').createSignedUploadUrl(uploadPath));
    const target = signedResumableTarget(signed.data!.signedUrl)!;
    let droppedAcknowledgement = false;
    let resumedOffset = 0;
    await uploadResumable({ target, size: bytes.length, contentType: 'video/mp4',
      readChunk: (start, end) => new Uint8Array(bytes.subarray(start, end)),
      wait: async () => undefined,
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === 'HEAD') resumedOffset = Number(response.headers.get('Upload-Offset'));
        // Storage accepted this chunk; simulate its acknowledgement being lost.
        if (init?.method === 'PATCH' && response.ok && !droppedAcknowledgement) {
          droppedAcknowledgement = true;
          throw new Error('Injected response loss');
        }
        return response;
      },
    });
    const uploaded = checked(await admin.storage.from('uploads').download(uploadPath));
    if (checksum(new Uint8Array(await uploaded.data!.arrayBuffer())) !== checksum(bytes)) throw new Error('Resumed bytes differ');
    if (resumedOffset !== RESUMABLE_CHUNK_BYTES) throw new Error('Transfer did not resume after confirmed first chunk');
    checked(await admin.storage.from('uploads').copy(uploadPath, publicPath, { destinationBucket: 'showcase_media' }));
    sql(`insert into public.posts(id,user_id,visibility,source_kind,post_format,category,showcase_asset_path) values ('${postId}','${ownerId}','private','manual','media','video','${publicPath}');`);
    checked(await admin.from('post_media').insert({ post_id: postId, storage_path: publicPath, media_kind: 'video', sort_order: 0 }));
    checked(await admin.storage.from('showcase_media').copy(publicPath, privatePath, { destinationBucket: 'post_media' }));
    checked(await admin.rpc('commit_uploaded_media_private_copy', { p_public_path: publicPath }));
    const denied = await readPostMedia({ admin, path: privatePath, viewerUserId: null });
    if (denied !== null) throw new Error('Private media was exposed');
    const ownerUrl = await readPostMedia({ admin, path: privatePath, viewerUserId: ownerId });
    if (!ownerUrl) throw new Error('Owner read denied');
    const partial = await fetch(ownerUrl, { headers: { Range: 'bytes=0-1023' } });
    if (partial.status !== 206 || (await partial.arrayBuffer()).byteLength !== 1024) throw new Error('Range playback failed');
    const direct = await fetch(admin.storage.from('post_media').getPublicUrl(privatePath).data.publicUrl);
    if (direct.ok) throw new Error('Private bucket has a public download');
    sql(`update public.posts set visibility='public' where id='${postId}';`);
    if (!await readPostMedia({ admin, path: privatePath, viewerUserId: null })) throw new Error('Public read failed');
    sql(`update public.posts set visibility='private' where id='${postId}';`);
    if (await readPostMedia({ admin, path: privatePath, viewerUserId: null })) throw new Error('Cached signature bypassed new visibility');
    await processUploadedMediaMaintenance(admin);
    if ((await fetch(admin.storage.from('showcase_media').getPublicUrl(publicPath).data.publicUrl)).ok) throw new Error('Old public copy survived revocation');
    sql(`delete from public.posts where id='${postId}';`);
    await processUploadedMediaMaintenance(admin);
    if ((await admin.storage.from('post_media').exists(privatePath)).data !== false) throw new Error('Delete left an original');
    console.info(JSON.stringify({ resumableBytesVerified: bytes.length, resumedOffset, privateRead: 'pass', rangeRead: '206 / 1024 bytes', visibilityCacheIsolation: 'pass', publicCopyRevocation: 'pass', deletion: 'pass' }));
  } finally {
    sql(`delete from public.posts where id='${postId}';`);
    await admin.storage.from('uploads').remove([uploadPath]);
    await admin.storage.from('post_media').remove([privatePath]);
    await admin.storage.from('showcase_media').remove([publicPath]);
    await admin.auth.admin.deleteUser(ownerId);
    sql(`delete from public.uploaded_media_private_copies where public_path='${publicPath}'; delete from public.post_media_object_cleanup where storage_path='${privatePath}';`);
  }
}
verify().catch((error) => { console.error(error instanceof Error ? error.message : String(error?.message ?? 'Local Storage probe failed').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]')); process.exitCode = 1; });
