export async function privilegedAudit(store, context, action, request, outcome) {
  return store.audit({ principal: context.principal, action, run_id: request?.run_id ?? null, request, outcome });
}
