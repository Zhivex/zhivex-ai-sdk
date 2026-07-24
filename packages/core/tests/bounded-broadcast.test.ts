import { describe, expect, it } from "vitest";

import { BoundedReplayBroadcast, StreamBufferOverflowError } from "../src/bounded-broadcast.js";

describe("BoundedReplayBroadcast", () => {
  it("applies backpressure when an active consumer falls behind", async () => {
    const broadcast = new BoundedReplayBroadcast<number>({
      maxHistory: 10,
      maxSubscriberQueue: 1
    });
    const iterator = broadcast.stream()[Symbol.asyncIterator]();
    const first = iterator.next();

    await broadcast.publish(1);
    expect(await first).toEqual({ done: false, value: 1 });

    await broadcast.publish(2);
    let thirdSettled = false;
    const thirdPublish = broadcast.publish(3).then(() => {
      thirdSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdSettled).toBe(false);

    expect(await iterator.next()).toEqual({ done: false, value: 2 });
    await thirdPublish;
    expect(await iterator.next()).toEqual({ done: false, value: 3 });

    broadcast.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("fails explicitly instead of dropping replay events at the retention limit", async () => {
    const broadcast = new BoundedReplayBroadcast<number>({ maxHistory: 2 });
    await broadcast.publish(1);
    await broadcast.publish(2);

    await expect(broadcast.publish(3)).rejects.toBeInstanceOf(StreamBufferOverflowError);

    const iterator = broadcast.stream()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    expect(await iterator.next()).toEqual({ done: false, value: 2 });
    await expect(iterator.next()).rejects.toMatchObject({
      name: "StreamBufferOverflowError",
      limit: 2
    });
  });

  it("retains bounded terminal events after normal replay capacity is reached", async () => {
    const broadcast = new BoundedReplayBroadcast<string>({ maxHistory: 1 });
    await broadcast.publish("delta");
    await broadcast.publish("finish", { terminal: true });
    broadcast.close();

    const replayed: string[] = [];
    for await (const value of broadcast.stream()) {
      replayed.push(value);
    }
    expect(replayed).toEqual(["delta", "finish"]);
  });
});
