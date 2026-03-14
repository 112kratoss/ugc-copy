import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

async function migrateExistingFiles() {
    console.log('Fetching generations...');
    const { data: generations, error: dbError } = await supabase
        .from('generations')
        .select('id, user_id, output_url');

    if (dbError || !generations) {
        console.error('Error fetching DB:', dbError);
        return;
    }

    console.log(`Found ${generations.length} records to process.`);

    let movedCount = 0;
    let skippedCount = 0;

    for (const gen of generations) {
        if (!gen.output_url || !gen.user_id) {
            skippedCount++;
            continue;
        }

        let bucket = '';
        let rawPath = '';

        // Extract the raw file path from the old public URLs
        if (gen.output_url.includes('generated_videos')) {
            bucket = 'generated_videos';
            rawPath = gen.output_url.split('generated_videos/')[1];
        } else if (gen.output_url.includes('generated_images')) {
            bucket = 'generated_images';
            rawPath = gen.output_url.split('generated_images/')[1];
        } else {
            skippedCount++;
            continue;
        }

        // Clean query parameters if any (e.g. ?t=xxxx)
        rawPath = rawPath.split('?')[0];

        // Ensure we don't move files that are already prefixed with the user_id
        if (rawPath.startsWith(`${gen.user_id}/`)) {
            skippedCount++;
            continue;
        }

        const newPath = `${gen.user_id}/${rawPath}`;
        console.log(`[Processing] Moving in '${bucket}': ${rawPath}  -->  ${newPath}`);

        // Move the file in Supabase storage
        const { error: moveError } = await supabase
            .storage
            .from(bucket)
            .move(rawPath, newPath);

        if (moveError) {
            // Note: If the file is missing from storage altogether, we'll hit this error.
            console.error(`  ↳ Error moving file ${rawPath}:`, moveError.message);
            continue;
        }

        // Update the database to point to the new private path structure
        const newDbUrl = `${bucket}/${newPath}`;
        const { error: updateError } = await supabase
            .from('generations')
            .update({ output_url: newDbUrl })
            .eq('id', gen.id);

        if (updateError) {
            console.error(`  ↳ DB Update failed for generation ${gen.id}:`, updateError.message);
        } else {
            console.log(`  ↳ Success`);
            movedCount++;
        }
    }

    console.log('\n--- Migration Complete ---');
    console.log(`Successfully moved and updated: ${movedCount}`);
    console.log(`Skipped (already moved or missing): ${skippedCount}`);
}

migrateExistingFiles();
