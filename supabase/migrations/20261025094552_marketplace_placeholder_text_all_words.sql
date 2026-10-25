-- The database's copy of the placeholder rule, moved to the rule the server and
-- both composers apply (isPlaceholderText in
-- ugc-mobile/lib/post-publish-policy/post-publish-policy.ts, cases in
-- contracts/public-post-quality-v1.json). The old body refused any text holding
-- a stand-in word anywhere ("Free sample pack", "Product demo with Kling 3.0"),
-- and cut every character but a-z and 0-9 before lowercasing, so capitals were
-- dropped ("Free" became "ree") and a title in Hindi read as empty. With the
-- TypeScript gates relaxed, apply_post_resource_bundle_mutation raised on those
-- recipe posts inside the publish RPC, after the media was in place.
--
-- Text is a placeholder when nothing but punctuation, symbols, emoji and links
-- is left; when it holds a decisive stand-in anywhere ("lorem ipsum"); when
-- every word is a stand-in, a filler word or a number and one is a stand-in
-- ("Demo video", "This is a test post", but not "Product demo"); or when it is
-- keyboard mash of Latin letters and digits ("ababab"). [[:alnum:]] keeps the
-- letters of every script under the database's UTF-8 locale.
-- src/__tests__/marketplace-placeholder-sql-migration.test.ts holds the three
-- word lists below to the contract.
CREATE OR REPLACE FUNCTION public.marketplace_text_is_placeholder(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH words AS (
    SELECT word
    FROM regexp_split_to_table(
      regexp_replace(lower(coalesce(p_value, '')), 'https?://\S+', ' ', 'g'),
      '[^[:alnum:]]+'
    ) AS word
    WHERE word <> ''
  ),
  compact AS (
    SELECT coalesce(string_agg(word, ''), '') AS value
    FROM words
  )
  SELECT
    NOT EXISTS (SELECT 1 FROM words)
    OR EXISTS (
      SELECT 1
      FROM words
      WHERE word IN (
        'asdf',
        'ipsum',
        'lorem'
      )
    )
    OR (
      EXISTS (
        SELECT 1
        FROM words
        WHERE word IN (
          'asdf',
          'demo',
          'draft',
          'example',
          'foo',
          'ipsum',
          'lorem',
          'placeholder',
          'sample',
          'test',
          'testing',
          'todo',
          'untitled'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM words
        WHERE word NOT IN (
          'asdf',
          'demo',
          'draft',
          'example',
          'foo',
          'ipsum',
          'lorem',
          'placeholder',
          'sample',
          'test',
          'testing',
          'todo',
          'untitled'
        )
        AND word NOT IN (
          'a',
          'an',
          'the',
          'my',
          'this',
          'new',
          'i',
          'me',
          'we',
          'our',
          'your',
          'it',
          'is',
          'are',
          'was',
          'be',
          'of',
          'for',
          'and',
          'or',
          'to',
          'in',
          'on',
          'at',
          'with',
          'just',
          'only',
          'here',
          'some',
          'one',
          'again',
          'post',
          'image',
          'images',
          'photo',
          'photos',
          'pic',
          'picture',
          'video',
          'videos',
          'text',
          'note',
          'clip',
          'render',
          'creation',
          'title',
          'file',
          'upload',
          'recipe',
          'prompt',
          'workflow'
        )
        AND word !~ '^[0-9]+$'
      )
    )
    OR (
      (SELECT value FROM compact) ~ '^[a-z0-9]{6,}$'
      AND (
        SELECT count(DISTINCT char_value)
        FROM regexp_split_to_table((SELECT value FROM compact), '') AS char_value
      ) <= 3
    );
$$;
