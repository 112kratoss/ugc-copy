import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const dryRun = process.argv.includes('--dry-run');

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

function detectCategoryFromModel(model) {
  if (model.includes('banana')) return 'image';
  if (model === 'kling-3.0/video' || model.includes('/video')) return 'video';
  if (model.startsWith('kling-')) return 'motion';
  return 'image';
}

function inferExtension(sourceName, category) {
  const candidate = sourceName.split('.').pop();
  if (candidate && candidate.length <= 5) {
    return candidate;
  }

  return category === 'image' ? 'jpg' : 'mp4';
}

function getStoredMediaLocation(outputUrl) {
  if (!outputUrl || typeof outputUrl !== 'string') {
    return null;
  }

  const normalized = outputUrl.replace(/^\/+/, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }

  return {
    bucket: normalized.slice(0, slashIndex),
    filePath: normalized.slice(slashIndex + 1),
  };
}

async function createShowcaseDerivative(generation) {
  const category = generation.category || detectCategoryFromModel(generation.model || '');
  const storedLocation = getStoredMediaLocation(generation.output_url);
  let fileBlob;
  let sourceName;
  let contentType = null;

  if (storedLocation) {
    sourceName = storedLocation.filePath.split('/').pop() || `${generation.id}.${inferExtension(generation.output_url, category)}`;
    const { data, error } = await supabase.storage
      .from(storedLocation.bucket)
      .download(storedLocation.filePath);

    if (error || !data) {
      throw new Error(`Failed to load source media from ${storedLocation.bucket}/${storedLocation.filePath}`);
    }

    fileBlob = data;
    contentType = data.type || null;
  } else if (generation.output_url.startsWith('http')) {
    const response = await fetch(generation.output_url);

    if (!response.ok) {
      throw new Error(`Failed to fetch source media from ${generation.output_url}`);
    }

    const url = new URL(generation.output_url);
    sourceName = path.basename(url.pathname) || `${generation.id}.${inferExtension(generation.output_url, category)}`;
    fileBlob = await response.blob();
    contentType = response.headers.get('content-type');
  } else {
    throw new Error('Unsupported media source for showcase backfill');
  }

  const baseName = path.basename(sourceName, path.extname(sourceName)) || generation.id;
  const showcaseAssetPath = `showcase/${generation.id}/${baseName}.${inferExtension(sourceName, category)}`;

  if (dryRun) {
    return showcaseAssetPath;
  }

  const { error: uploadError } = await supabase.storage
    .from(SHOWCASE_MEDIA_BUCKET)
    .upload(showcaseAssetPath, fileBlob, {
      cacheControl: '3600',
      contentType: contentType || (category === 'image' ? 'image/jpeg' : 'video/mp4'),
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload showcase derivative: ${uploadError.message}`);
  }

  return showcaseAssetPath;
}

async function fetchPublicGenerations() {
  const rows = [];
  const pageSize = 100;

  for (let page = 0; ; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('generations')
      .select('id, model, category, output_url, showcase_asset_path')
      .eq('is_public', true)
      .eq('status', 'succeeded')
      .is('showcase_asset_path', null)
      .not('output_url', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, to);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      break;
    }

    rows.push(...data);

    if (data.length < pageSize) {
      break;
    }
  }

  return rows;
}

async function backfillShowcaseAssets() {
  const generations = await fetchPublicGenerations();

  console.log(`Found ${generations.length} public generation(s) missing showcase_asset_path.`);

  let updated = 0;
  let failed = 0;

  for (const generation of generations) {
    try {
      const showcaseAssetPath = await createShowcaseDerivative(generation);

      if (!dryRun) {
        const { error } = await supabase
          .from('generations')
          .update({ showcase_asset_path: showcaseAssetPath })
          .eq('id', generation.id);

        if (error) {
          throw error;
        }
      }

      updated += 1;
      console.log(`[ok] ${generation.id} -> ${showcaseAssetPath}${dryRun ? ' (dry-run)' : ''}`);
    } catch (error) {
      failed += 1;
      console.log(`[fail] ${generation.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  console.log('');
  console.log(`Updated: ${updated}`);
  console.log(`Failed: ${failed}`);
}

backfillShowcaseAssets().catch((error) => {
  console.error('Showcase asset backfill failed:', error);
  process.exit(1);
});
