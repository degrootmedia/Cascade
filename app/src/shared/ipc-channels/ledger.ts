/** Ledger (expenses) IPC channels. Fragment of ipcContract. */
export const ledgerChannels = {
  "ledger:get": { method: "getLedger", kind: "invoke" },
  "ledger:getPriceRules": { method: "getExpensePriceRules", kind: "invoke" },
  "ledger:setPriceRules": { method: "setExpensePriceRules", kind: "invoke" },
  "ledger:reprice": { method: "repriceExpenses", kind: "invoke" },
  "ledger:exportRules": { method: "exportExpensePriceRules", kind: "invoke" },
  "ledger:importRules": { method: "importExpensePriceRules", kind: "invoke" },
  "ledger:addManual": { method: "addManualExpense", kind: "invoke" },
  "ledger:removeEntry": { method: "removeLedgerEntry", kind: "invoke" },
  "ledger:openFile": { method: "openLedgerFile", kind: "invoke" },
} as const;
