import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/server-helpers';
import {
    BackendRateLimitError,
    CONTACT_SUBMISSION_RATE_LIMIT,
    createBackendRateLimitResponse,
    enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

function getContactRateLimitKey(request: Request) {
    const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const realIp = request.headers.get('x-real-ip')?.trim();

    return forwardedFor || realIp || '127.0.0.1';
}

export async function POST(req: Request) {
    try {
        const { name, email, subject, message } = await req.json();

        if (!name || !email || !message) {
            return NextResponse.json(
                { error: 'Name, email, and message are required' },
                { status: 400 }
            );
        }

        // Basic email validation
        if (!email.includes('@') || !email.includes('.')) {
            return NextResponse.json(
                { error: 'Invalid email address' },
                { status: 400 }
            );
        }

        const adminSupabase = createServiceClient();

        try {
            await enforceBackendRateLimit(adminSupabase, {
                ...CONTACT_SUBMISSION_RATE_LIMIT,
                key: getContactRateLimitKey(req),
            });
        } catch (error) {
            if (error instanceof BackendRateLimitError) {
                return createBackendRateLimitResponse(error);
            }

            console.error('Contact rate limit check failed:', error);
            return NextResponse.json(
                { error: 'Failed to check contact submission limits.' },
                { status: 500 }
            );
        }

        const { error } = await adminSupabase
            .from('contact_messages')
            .insert({
                name: name.trim(),
                email: email.trim().toLowerCase(),
                subject: subject || 'general',
                message: message.trim(),
            });

        if (error) {
            console.error('Error saving contact message:', error);
            return NextResponse.json(
                { error: 'Failed to send message. Please try again.' },
                { status: 500 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Contact API error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
