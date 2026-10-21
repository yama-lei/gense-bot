import type { Outgoing, TurnBody } from '../types'

/**
 * First messages of chats created on the home page, sent by the chat's bridge once it connects.
 * Module-level so a StrictMode remount cannot send one twice.
 */
export const pending = new Map<string, { message: Outgoing } & TurnBody>()
