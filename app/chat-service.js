function createChatService({
  store,
  ollamaUrl,
  model,
  systemPrompt,
  timeoutMs,
  maxPending
}) {
  const chatQueue = [];
  const userPendingJobs = new Map();
  let queueWorkerActive = false;

  function getUserPendingJobCount(email) {
    return userPendingJobs.get(email) || 0;
  }

  function incrementUserPendingJobs(email) {
    userPendingJobs.set(email, getUserPendingJobCount(email) + 1);
  }

  function decrementUserPendingJobs(email) {
    const next = getUserPendingJobCount(email) - 1;
    if (next <= 0) {
      userPendingJobs.delete(email);
    } else {
      userPendingJobs.set(email, next);
    }
  }

  function getTotalPendingJobCount() {
    return chatQueue.length + (queueWorkerActive ? 1 : 0);
  }

  function runChatQueueWorker() {
    if (queueWorkerActive) return;
    queueWorkerActive = true;

    (async () => {
      while (chatQueue.length > 0) {
        const job = chatQueue.shift();
        try {
          const result = await job.run();
          job.resolve(result);
        } catch (error) {
          job.reject(error);
        } finally {
          decrementUserPendingJobs(job.email);
        }
      }
    })()
      .catch(() => {
        // Per-job errors are handled above. This keeps the worker from crashing silently.
      })
      .finally(() => {
        queueWorkerActive = false;
        if (chatQueue.length > 0) {
          runChatQueueWorker();
        }
      });
  }

  function enqueueChatJob(email, run) {
    if (getTotalPendingJobCount() >= maxPending) {
      const error = new Error("Chat queue is full. Please try again shortly.");
      error.code = "QUEUE_FULL";
      throw error;
    }

    incrementUserPendingJobs(email);
    return new Promise((resolve, reject) => {
      chatQueue.push({ email, run, resolve, reject });
      runChatQueueWorker();
    });
  }

  async function runChatTurn(email, content) {
    const state = store.getUserState(email);

    state.messages.push({
      role: "user",
      content,
      timestamp: Date.now()
    });
    state.updatedAt = Date.now();
    store.persistUserState(email);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const messagesForOllama = [
        { role: "system", content: systemPrompt },
        ...(state.longTerm
          ? [{ role: "system", content: `Long-term memory:\n${state.longTerm}` }]
          : []),
        ...state.messages.map((m) => ({ role: m.role, content: m.content }))
      ];

      const ollamaRes = await fetch(ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: messagesForOllama,
          stream: false
        }),
        signal: controller.signal
      });

      if (!ollamaRes.ok) {
        const text = await ollamaRes.text();
        throw new Error(`Ollama error ${ollamaRes.status}: ${text}`);
      }

      const data = await ollamaRes.json();
      const assistantContent =
        (typeof data?.message?.content === "string" && data.message.content) ||
        (typeof data?.response === "string" && data.response) ||
        "";

      if (!assistantContent.trim()) {
        throw new Error("Invalid Ollama response");
      }

      const assistantMessage = {
        role: "assistant",
        content: assistantContent.trim(),
        timestamp: Date.now()
      };

      state.messages.push(assistantMessage);
      state.updatedAt = Date.now();
      store.persistUserState(email);

      return assistantMessage;
    } finally {
      clearTimeout(timer);
    }
  }

  function getHistory(email) {
    const state = store.getUserState(email);
    return {
      messages: state.messages,
      isBusy: getUserPendingJobCount(email) > 0,
      queue: {
        totalPending: getTotalPendingJobCount(),
        maxPending
      }
    };
  }

  async function sendMessage(email, content) {
    return enqueueChatJob(email, () => runChatTurn(email, content));
  }

  return {
    getHistory,
    sendMessage
  };
}

module.exports = {
  createChatService
};
