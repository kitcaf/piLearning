import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

// NOTE EventStream 由厂商大模型llm的输出直接EventStream.push(AssistantMessageEvent)
// Generic event stream class for async iteration
// 管理一次LLM的调用（包含两种：过程状态 + 最终状态）
// 经典的"队列 + 等待者"模式
// 不能单独队列 消费者忙的时候,新事件排队,保证一个个按序处理


/**
生产者（网络回调）和消费者（for-await 循环）速度不同步，且是双向的：
- 生产快、消费慢 → 事件要排队（ queue ）
- 消费快、生产慢 → 消费者要挂起等待（ waiting ）



 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = []; // 生产者队列 - llm
	private waiting: ((value: IteratorResult<T>) => void)[] = []; // 消费者队列 - ui消费 / 读取文件 ...
	// 在无货的时候进入waiting 队列进行等待，所以基本上就是0/1
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void { //生产者推事件
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		// 唤醒消费者
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void { // 生成收尾
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	// 消费者一个一个读事件
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	// 只关系结果
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
