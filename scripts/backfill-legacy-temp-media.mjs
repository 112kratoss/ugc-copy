import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const LEGACY_HOST = 'tempfile.aiquickdraw.com';
const dryRun = process.argv.includes('--dry-run');

function inferMediaTarget(generation, responseContentType) {
    const pathname = (() => {
        try {
            return new URL(generation.output_url).pathname.toLowerCase();
        } catch {
            return '';
        }
    })();

    const contentType = (responseContentType || '').toLowerCase();
    const model = (generation.model || '').toLowerCase();
    const extensionFromPath = pathname.split('.').pop();

    if (
        contentType.startsWith('video/') ||
        pathname.endsWith('.mp4') ||
        pathname.endsWith('.mov') ||
        model.includes('motion-control') ||
        model.startsWith('kling')
    ) {
        return {
            bucket: 'generated_videos',
            extension: extensionFromPath === 'mov' ? 'mov' : 'mp4',
            contentType: contentType || 'video/mp4',
        };
    }

    if (
        contentType.startsWith('image/') ||
        pathname.endsWith('.png') ||
        pathname.endsWith('.jpg') ||
        pathname.endsWith('.jpeg') ||
        pathname.endsWith('.webp')
    ) {
        const extension = extensionFromPath === 'jpeg' ? 'jpg' : extensionFromPath || 'png';
        return {
            bucket: 'generated_images',
            extension,
            contentType: contentType || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
        };
    }

    return null;
}

async function fetchLegacyGenerations() {
    const allRows = [];
    const pageSize = 100;

    for (let page = 0; ; page++) {
        const from = page * pageSize;
        const to = from + pageSize - 1;

        const { data, error } = await supabase
            .from('generations')
            .select('id, user_id, prediction_id, output_url, model, created_at')
            .eq('status', 'succeeded')
            .like('output_url', `https://${LEGACY_HOST}/%`)
            .order('created_at', { ascending: true })
            .range(from, to);

        if (error) {
            throw error;
        }

        if (!data || data.length === 0) {
            break;
        }

        allRows.push(...data);

        if (data.length < pageSize) {
            break;
        }
    }

    return allRows;
}

async function backfill() {
    const generations = await fetchLegacyGenerations();

    console.log(`Found ${generations.length} legacy media record(s) on ${LEGACY_HOST}.`);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    for (const generation of generations) {
        if (!generation.user_id || !generation.prediction_id || !generation.output_url) {
            skipped++;
            console.log(`[skip] ${generation.id} is missing user_id, prediction_id, or output_url`);
            continue;
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(generation.output_url);
        } catch {
            failed++;
            console.log(`[fail] ${generation.id} has an invalid URL`);
            continue;
        }

        if (parsedUrl.hostname !== LEGACY_HOST) {
            skipped++;
            continue;
        }

        try {
            const response = await fetch(generation.output_url);
            if (!response.ok) {
                failed++;
                console.log(`[fail] ${generation.id} download returned ${response.status}`);
                continue;
            }

            const target = inferMediaTarget(generation, response.headers.get('content-type'));
            if (!target) {
                failed++;
                console.log(`[fail] ${generation.id} could not infer target bucket/type`);
                continue;
            }

            const filePath = `${generation.user_id}/generated_${generation.prediction_id}.${target.extension}`;
            const dbPath = `${target.bucket}/${filePath}`;

            if (dryRun) {
                console.log(`[dry-run] ${generation.id} -> ${dbPath}`);
                migrated++;
                continue;
            }

            const fileBuffer = Buffer.from(await response.arrayBuffer());
            const { error: uploadError } = await supabase.storage
                .from(target.bucket)
                .upload(filePath, fileBuffer, {
                    contentType: target.contentType,
                    upsert: true,
                });

            if (uploadError) {
                failed++;
                console.log(`[fail] ${generation.id} upload failed: ${uploadError.message}`);
                continue;
            }

            const { error: updateError } = await supabase
                .from('generations')
                .update({ output_url: dbPath })
                .eq('id', generation.id);

            if (updateError) {
                failed++;
                console.log(`[fail] ${generation.id} db update failed: ${updateError.message}`);
                continue;
            }

            migrated++;
            console.log(`[ok] ${generation.id} -> ${dbPath}`);
        } catch (error) {
            failed++;
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.log(`[fail] ${generation.id} unexpected error: ${message}`);
        }
    }

    console.log('');
    console.log('Backfill complete');
    console.log(`Migrated: ${migrated}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Failed: ${failed}`);
}

backfill().catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
});
