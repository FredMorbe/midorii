import { setRuleStrategies } from './index';

export async function refreshResearchStrategies(): Promise<void> {
    if (window.midori.research) setRuleStrategies(await window.midori.research.strategies());
}
