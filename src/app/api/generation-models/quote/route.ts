import { NextRequest, NextResponse } from 'next/server';

import {
  CatalogError,
  quoteGenerationModel,
  type GenerationModelKind,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' };

function isGenerationModelKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<GenerationModelQuoteInput>;
    if (!isGenerationModelKind(body.kind) || typeof body.modelId !== 'string' || !body.modelId) {
      return NextResponse.json(
        { code: 'INVALID_MODEL_SETTINGS', error: 'A valid kind and modelId are required.', fieldErrors: {} },
        { status: 422, headers: NO_STORE_HEADERS }
      );
    }

    return NextResponse.json(quoteGenerationModel({
      kind: body.kind,
      modelId: body.modelId,
      settings: body.settings,
      inputCounts: body.inputCounts,
      catalogRevision: body.catalogRevision,
    }), { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof CatalogError) {
      return NextResponse.json({
        code: error.code,
        error: error.message,
        fieldErrors: error.fieldErrors,
      }, { status: error.status, headers: NO_STORE_HEADERS });
    }

    return NextResponse.json(
      { code: 'INVALID_MODEL_SETTINGS', error: 'The quote request could not be processed.', fieldErrors: {} },
      { status: 422, headers: NO_STORE_HEADERS }
    );
  }
}
