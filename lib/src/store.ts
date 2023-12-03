/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { createRootProxy, unwrapProxy } from "./proxy";
import { isFunction } from "./utils";

export type Store<T extends {}> = {
  state: T;
};
type StoreInternals<T extends {}> = Store<T> & {
  currentConsumerId: ConsumerID | null;
  registerConsumer: (id: ConsumerID, callbacks: ConsumerCallbacks) => () => void;
};
export type Selector<T extends {}, R> = (state: T) => R;

type Consumer<T extends {}> = {
  proxy: T;
  destroy: () => void;
};
type ConsumerID = symbol;
type ConsumerTarget = {};
type ConsumerTargetProp = string | symbol;
type DependenciesMap = WeakMap<ConsumerTarget, Map<ConsumerTargetProp, Set<ConsumerID>>>;
type ConsumerCallbacks = { rerender: () => void; revoke: (target: ConsumerTarget) => void };
type ConsumerCallbacksMap = WeakMap<ConsumerID, ConsumerCallbacks>;
type ConsumerDependenciesCleanupMap = WeakMap<ConsumerID, Set<Set<ConsumerID>>>;
type ConsumerTargetPropValueMap = WeakMap<
  ConsumerTarget,
  Map<ConsumerTargetProp, WeakMap<ConsumerID, unknown>>
>;

const stateToStoreInternalsMap = new WeakMap<{}, StoreInternals<{}>>();

export const createStoreFromBuilder = <T extends {}>(builder: (root: T) => T): Store<T> => {
  const targetDependenciesMap: DependenciesMap = new WeakMap();
  const consumerCallbacksMap: ConsumerCallbacksMap = new WeakMap();
  const consumerDependenciesCleanupMap: ConsumerDependenciesCleanupMap = new WeakMap();
  const consumerTargetPropValueMap: ConsumerTargetPropValueMap = new WeakMap();

  const getAffectedConsumers = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    const targetDependencies = targetDependenciesMap.get(target);
    if (!targetDependencies) return [];
    return targetDependencies.get(prop) ?? [];
  };

  const notifyConsumers = (
    target: ConsumerTarget,
    prop: ConsumerTargetProp,
    handler: (consumerId: ConsumerID, callbacks: ConsumerCallbacks) => void
  ) => {
    const consumers = getAffectedConsumers(target, prop);

    for (const consumerId of consumers) {
      const callbacks = consumerCallbacksMap.get(consumerId);
      if (!callbacks) throw new Error("Consumer callback not found");
      handler(consumerId, callbacks);
    }
  };

  const notifySet = (target: ConsumerTarget, prop: ConsumerTargetProp, value: unknown) => {
    notifyConsumers(target, prop, (consumerId, callbacks) => {
      // console.log("notify set", { consumerId, target, prop, value });

      const targetPropValueMap = consumerTargetPropValueMap.get(target);
      if (!targetPropValueMap) throw new Error("Target prop value map not found");

      const propValueMap = targetPropValueMap.get(prop);
      if (!propValueMap) throw new Error("Prop value map not found");

      const oldValue = propValueMap.get(consumerId);
      if (Object.is(oldValue, value)) return;

      propValueMap.set(consumerId, value);

      callbacks.revoke(target);
      callbacks.rerender();
    });
  };

  const notifyDelete = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    notifyConsumers(target, prop, (consumerId, callbacks) => {
      // console.log("notify delete", { consumerId, target, prop });

      const targetPropValueMap = consumerTargetPropValueMap.get(target);
      if (!targetPropValueMap) throw new Error("Target prop value map not found");

      const propValueMap = targetPropValueMap.get(prop);
      if (!propValueMap) throw new Error("Prop value map not found");

      propValueMap.delete(consumerId);

      callbacks.revoke(target);
      callbacks.rerender();
    });
  };

  const internals = { currentConsumerId: null } as StoreInternals<T>;

  const state = createRootProxy(builder, {
    callbacks: {
      get: (target, prop, _receiver, value) => {
        if (!internals.currentConsumerId) return;

        let targetDependencies = targetDependenciesMap.get(target);
        if (!targetDependencies) {
          targetDependencies = new Map();
        }
        targetDependenciesMap.set(target, targetDependencies);

        let propConsumers = targetDependencies.get(prop);
        if (!propConsumers) {
          propConsumers = new Set();
          targetDependencies.set(prop, propConsumers);
        }
        propConsumers.add(internals.currentConsumerId);

        const consumerDependencies = consumerDependenciesCleanupMap.get(internals.currentConsumerId);
        if (!consumerDependencies) throw new Error("Consumer dependencies not found");
        consumerDependencies.add(propConsumers);

        let targetPropValueMap = consumerTargetPropValueMap.get(target);
        if (!targetPropValueMap) {
          targetPropValueMap = new Map();
          consumerTargetPropValueMap.set(target, targetPropValueMap);
        }

        let propValueMap = targetPropValueMap.get(prop);
        if (!propValueMap) {
          propValueMap = new WeakMap();
          targetPropValueMap.set(prop, propValueMap);
        }

        propValueMap.set(internals.currentConsumerId, value);
      },
      set: (target, prop, value, _receiver) => {
        notifySet(target, prop, value);
      },
      deleteProperty: (target, prop) => {
        notifyDelete(target, prop);
      },
    },
  });

  const registerConsumer = (
    id: ConsumerID,
    callbacks: { rerender: () => void; revoke: (target: ConsumerTarget) => void }
  ) => {
    consumerCallbacksMap.set(id, callbacks);
    consumerDependenciesCleanupMap.set(id, new Set());

    return () => {
      consumerCallbacksMap.delete(id);

      const dependencySets = consumerDependenciesCleanupMap.get(id);
      if (!dependencySets) return;

      for (const set of dependencySets) {
        set.delete(id);
      }
      consumerDependenciesCleanupMap.delete(id);
    };
  };

  internals.state = state;
  internals.registerConsumer = registerConsumer;
  stateToStoreInternalsMap.set(state, internals);

  return { state };
};

export const createStore = <T extends {}>(target: T) => {
  const builder = isFunction(target) ? target : () => target;
  const store = createStoreFromBuilder(builder as (root: T) => T);
  return {
    state: store.state as T extends (...args: any[]) => any ? ReturnType<T> : T,
  };
};

let consumerIdCounter = 0;
export const createConsumer = <T extends {}>(store: Store<T>, callback: () => void): Consumer<T> => {
  const consumerId = Symbol(`store-consumer:${consumerIdCounter++}`);
  const proxyCache = new WeakMap<{}, {}>();

  const storeInternals = stateToStoreInternalsMap.get(store.state);
  if (!storeInternals) throw new Error("Store internals not found");

  const revokeCachedProxy = (target: {}) => proxyCache.delete(target);

  const unregisterConsumer = storeInternals.registerConsumer(consumerId, {
    rerender: callback,
    revoke: revokeCachedProxy,
  });

  const handlers: ProxyHandler<{}> = {
    get(target, prop, receiver) {
      // console.log("@consumer get", consumerId, { target, prop, receiver });
      storeInternals.currentConsumerId = consumerId;

      try {
        const result = Reflect.get(target, prop, receiver);
        if (typeof result === "object" && result !== null && !(result instanceof Function)) {
          const unwrappedResult = unwrapProxy(result);
          if (proxyCache.has(unwrappedResult)) return proxyCache.get(unwrappedResult);
          const proxy = new Proxy(result, handlers);
          proxyCache.set(unwrappedResult, proxy);
          return proxy;
        }
        return result;
      } finally {
        storeInternals.currentConsumerId = null;
      }
    },
  };
  const { proxy, revoke } = Proxy.revocable(store.state, handlers);

  const destroy = () => {
    unregisterConsumer();
    revoke();
  };

  return { proxy: proxy as T, destroy };
};

const createMemoizedConsumer = <T extends {}, R>(
  store: Store<T>,
  selectorRef: React.MutableRefObject<Selector<T, R> | undefined>,
  valueRef: React.MutableRefObject<R>,
  updateRef: React.MutableRefObject<{}>
) => {
  let referenceCount = 0;
  let callbackRef = () => {};

  const consumer = createConsumer(store, () => {
    if (selectorRef.current) {
      const newValue = selectorRef.current(consumer.proxy as T);
      if (Object.is(newValue, valueRef.current)) return;
      // eslint-disable-next-line no-param-reassign
      valueRef.current = newValue;
    } else {
      // eslint-disable-next-line no-param-reassign
      valueRef.current = new Proxy(consumer.proxy, {}) as unknown as R;
    }
    // eslint-disable-next-line no-param-reassign
    updateRef.current = {};
    callbackRef();
  });

  const subscribe = (callback: () => void) => {
    callbackRef = callback;
    referenceCount++;

    return () => {
      referenceCount--;

      setTimeout(() => {
        if (referenceCount === 0) consumer.destroy();
      }, 0);
    };
  };

  return { subscribe, proxy: consumer.proxy };
};

const initRefValue = {};

export function useStore<T extends {}>(store: Store<T>): T;
export function useStore<T extends {}, R>(store: Store<T>, selector: Selector<T, R>): R;
export function useStore<T extends {}, R>(store: Store<T>, selector?: Selector<T, R>) {
  const updateRef = useRef({});
  const valueRef = useRef<R>(initRefValue as unknown as R);
  const selectorRef = useRef(selector);

  selectorRef.current = selector;

  const memoizedConsumer = useMemo(() => {
    return createMemoizedConsumer<T, R>(store, selectorRef, valueRef, updateRef);
  }, [store]);

  useSyncExternalStore(memoizedConsumer.subscribe, () => updateRef.current);

  if (selectorRef.current) {
    if (valueRef.current === initRefValue) {
      valueRef.current = selectorRef.current(memoizedConsumer.proxy);
    }
    return valueRef.current;
  }

  return valueRef.current === initRefValue ? memoizedConsumer.proxy : valueRef.current;
}
