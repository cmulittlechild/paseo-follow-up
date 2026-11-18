// @getpaseo/plugin/client under the strict native stand-in: hooks a rendered component may call, inert.
export const openExternalUrl = async () => {};
export const useAgent = () => null;
export const usePaseo = () => ({});
/** Every RPC a rendered component made, in order, with its input; `rpcReply` answers them (default: a sent answer). */
export const rpcCalls = [];
export const rpc = { reply: (_name, _input) => ({ question: { answer: { delivery: { state: "sent" } } } }) };
export const useRpc = contract => async input => { rpcCalls.push({ name: contract?.name, input }); return rpc.reply(contract?.name, input); };
export const useSettings = () => ({ data: undefined });
export const useTabState = (_k, init) => [init, () => {}];
/**
 * Paseo's dictation hook: absent by default, as on a Paseo without it (0.16). `dictationHost.set(hook)` adds a fake,
 * `set(undefined)` removes it again; the live binding is what `import * as client` reads.
 */
export let usePaseoDictation = undefined;
export const dictationHost = { set(hook) { usePaseoDictation = hook; } };
