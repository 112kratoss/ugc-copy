begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(20);

-- The database's copy of the placeholder rule answers as the TypeScript rule
-- does (contracts/public-post-quality-v1.json). The old copy refused "Free
-- sample pack" and every title in Hindi inside the publish RPC, after both
-- composers and the server had taken them.

-- Real titles that use a stand-in word, or another script.
select is(public.marketplace_text_is_placeholder('Free sample pack'), false, 'a real title that uses "sample" is not a placeholder');
select is(public.marketplace_text_is_placeholder('Product demo with Kling 3.0'), false, 'a real title that uses "demo" is not a placeholder');
select is(public.marketplace_text_is_placeholder('My first test'), false, 'a real title that uses "test" is not a placeholder');
select is(public.marketplace_text_is_placeholder('FREE SAMPLE'), false, 'capitals are lowercased before the cut, not dropped');
select is(public.marketplace_text_is_placeholder('नमस्ते दुनिया'), false, 'a title in Hindi is words');
select is(public.marketplace_text_is_placeholder('东京之夜'), false, 'a title in Chinese is words');
select is(public.marketplace_text_is_placeholder('Lol 😂😂😂'), false, 'emoji after a word are not keyboard mash');
select is(public.marketplace_text_is_placeholder('A quick test of soft window light'), false, 'a sentence that uses "test" is not a placeholder');

-- Stand-ins with only filler words and numbers around them.
select is(public.marketplace_text_is_placeholder('Demo video'), true, '"Demo video" is a placeholder');
select is(public.marketplace_text_is_placeholder('Untitled recipe'), true, '"Untitled recipe" is a placeholder');
select is(public.marketplace_text_is_placeholder('test 2'), true, 'a number does not rescue a stand-in');
select is(public.marketplace_text_is_placeholder('This is a test post'), true, 'stop words do not rescue a stand-in');

-- Decisive stand-ins, anywhere.
select is(public.marketplace_text_is_placeholder('Lorem ipsum dolor sit amet, consectetur adipiscing elit'), true, 'lorem ipsum is a placeholder wherever it appears');

-- No letters or digits left.
select is(public.marketplace_text_is_placeholder('…'), true, 'an ellipsis alone is a placeholder');
select is(public.marketplace_text_is_placeholder('🔥🔥'), true, 'emoji alone are a placeholder');
select is(public.marketplace_text_is_placeholder('“Untitled”'), true, 'curly quotes do not hide a stand-in');
select is(public.marketplace_text_is_placeholder('https://example.com'), true, 'a link alone is a placeholder');
select is(public.marketplace_text_is_placeholder(null), true, 'null is a placeholder');

-- Keyboard mash.
select is(public.marketplace_text_is_placeholder('ababab'), true, 'keyboard mash is a placeholder');
select is(public.marketplace_text_is_placeholder('Sdfds'), false, 'a short odd word is not mash');

select * from finish();
rollback;
