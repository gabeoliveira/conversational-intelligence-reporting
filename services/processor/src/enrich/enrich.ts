/**
 * CUSTOMIZATION SURFACE: Enrichment Hook
 *
 * This file is the primary place for customers to add business logic.
 * Modify this function to:
 * - Map customerKey → internal CRM IDs
 * - Add business context from external systems
 * - Redact sensitive fields
 * - Compute derived fields
 *
 * This function is async-capable, so you can make external API calls
 * (CRM, lookup services, etc.) without blocking.
 *
 * Error handling:
 * - If enrichment fails, the record is still written with an enrichmentError flag
 * - Enrichment errors are logged but don't block ingest
 */

export interface EnrichmentContext {
  tenantId: string;
  conversationId: string;
  operatorName: string;
  rawPayload: Record<string, unknown>;
}

export interface EnrichmentResult {
  enrichedPayload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Enrich the raw payload with additional business context.
 *
 * @param ctx - The enrichment context containing tenant, conversation, and payload info
 * @returns The enriched payload and optional metadata
 *
 * @example
 * // Add CRM customer name lookup
 * export async function enrich(ctx: EnrichmentContext): Promise<EnrichmentResult> {
 *   const { rawPayload } = ctx;
 *   const customerId = rawPayload.customerId as string;
 *
 *   if (customerId) {
 *     const customerName = await lookupCustomerName(customerId);
 *     return {
 *       enrichedPayload: {
 *         ...rawPayload,
 *         customerName,
 *       },
 *     };
 *   }
 *
 *   return { enrichedPayload: rawPayload };
 * }
 */
export async function enrich(ctx: EnrichmentContext): Promise<EnrichmentResult> {
  const { rawPayload } = ctx;

  // Default implementation: pass through unchanged
  // Customize this function to add your business logic

  return {
    enrichedPayload: rawPayload,
  };
}
