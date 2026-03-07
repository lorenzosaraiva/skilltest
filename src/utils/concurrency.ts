export async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("pMap concurrency must be an integer greater than or equal to 1.");
  }

  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);

  return new Promise<R[]>((resolve, reject) => {
    let nextIndex = 0;
    let completed = 0;
    let rejected = false;

    const launchNext = (): void => {
      if (rejected) {
        return;
      }

      if (completed === items.length) {
        resolve(results);
        return;
      }

      if (nextIndex >= items.length) {
        return;
      }

      const currentIndex = nextIndex;
      nextIndex += 1;

      Promise.resolve()
        .then(() => fn(items[currentIndex], currentIndex))
        .then((result) => {
          if (rejected) {
            return;
          }

          results[currentIndex] = result;
          completed += 1;

          if (completed === items.length) {
            resolve(results);
            return;
          }

          launchNext();
        })
        .catch((error: unknown) => {
          if (rejected) {
            return;
          }

          rejected = true;
          reject(error);
        });
    };

    const initialWorkers = Math.min(concurrency, items.length);
    for (let workerIndex = 0; workerIndex < initialWorkers; workerIndex += 1) {
      launchNext();
    }
  });
}
