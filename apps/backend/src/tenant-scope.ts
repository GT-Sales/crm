/**
 * The tenant a store call runs for: the site (`workspaceId`) and the verified
 * actor behind it. A write also carries the request id its audit event is
 * recorded under.
 */
export interface Scope {
  workspaceId: string;
  actorId: string;
}

export interface WriteScope extends Scope {
  requestId: string;
}
