import type { PromptLengthMeter } from '../../ugc-mobile/lib/model-catalog/provider-prompt-limits';

const TONE_CLASS: Record<PromptLengthMeter['state'], string> = {
    within: 'text-zinc-600',
    near: 'text-amber-300',
    over: 'text-rose-300',
};

/**
 * A prompt's length against its model's limit, "4,812 / 5,000": quiet while there is
 * room, amber in the limit's last tenth, rose past it. The text past a limit is never
 * cut, by this or by the box (whose maxLength stays the route's shared one, so a paste
 * or a switch to a model with a lower limit keeps every word); the run waits instead,
 * and the creator says why beside Generate.
 */
export default function PromptLengthCounter({
    meter,
    suffix = '',
    className = '',
}: {
    meter: PromptLengthMeter;
    /** Words after the numbers, as the image creator's " characters". */
    suffix?: string;
    className?: string;
}) {
    return (
        <span data-testid="prompt-length" data-state={meter.state} className={`${TONE_CLASS[meter.state]} tabular-nums ${className}`.trim()}>
            {`${meter.label}${suffix}`}
        </span>
    );
}
