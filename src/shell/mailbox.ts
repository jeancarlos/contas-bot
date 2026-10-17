export type Mailbox = (jid: string, job: () => Promise<void>) => Promise<void>

export function mailbox(): Mailbox {
  const tails = new Map<string, Promise<void>>()
  return (jid, job) => {
    const run = (tails.get(jid) ?? Promise.resolve()).then(job)
    tails.set(
      jid,
      run.catch(() => undefined),
    )
    return run
  }
}
