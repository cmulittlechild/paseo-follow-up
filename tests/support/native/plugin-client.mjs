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
