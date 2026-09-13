'use strict';
async function withinDeadline(operation, deadlineAt) {
  if (!deadlineAt) return operation();
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Search deadline reached');
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Search deadline reached')), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
function deadlineAfter(budgetMs) {
  const budget = Number(budgetMs);
  return budget > 0 ? Date.now() + Math.max(1, budget - Math.min(250, budget * 0.1)) : 0;
}
module.exports = {withinDeadline, deadlineAfter};
