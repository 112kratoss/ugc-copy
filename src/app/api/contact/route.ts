import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/server-helpers';

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

        const { error } = await createServiceClient()
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
