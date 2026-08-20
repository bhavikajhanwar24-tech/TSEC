/**
 * Event queue — RepoGuardian
 *
 * Webhook handlers enqueue work and return a fast 202 to GitHub; a single
 * worker loop drains the queue so events are never processed inline. Jobs
 * are simple objects with a `run(job)` handler. The queue is in-memory
 * (mirrors healthRuns): a server restart drops pending jobs, which is
 * acceptable for this deployment and keeps zero external infrastructure.
 */

const queue = [];
let processing = false;

function enqueue(job) {
  queue.push(job);
  drain();
  return queue.length;
}

async function drain() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue.shift();
    const started = Date.now();
    try {
      await job.run(job);
    } catch (error) {
      console.error(`Event queue job failed (${job.type || "unknown"}):`, error.message);
    }
    console.log(`Event queue job ${job.type || "unknown"} finished in ${Date.now() - started}ms`);
  }
  processing = false;
}

function status() {
  return { queued: queue.length, processing };
}

module.exports = { enqueue, status };