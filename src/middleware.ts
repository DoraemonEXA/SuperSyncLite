import type { FastifyReply, FastifyRequest } from 'fastify';
import { checkToken, type Identity } from './auth';
const identities = new WeakMap<FastifyRequest, Identity>();
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
  const { user, error } = await checkToken(token);
  if (!user) return reply.code(401).send({ error });
  identities.set(req, user);
}
export function getAuthUser(req: FastifyRequest) {
  return identities.get(req)!;
}
