import { registerNativeIndicator } from '../NativeIndicator';
import { compareDescriptor, spreadDescriptor } from './CompareIndicator';

/** Register the compare and spread indicators (idempotent — called by the Vela constructor). */
export function registerCompare(): void {
    registerNativeIndicator(compareDescriptor);
    registerNativeIndicator(spreadDescriptor);
}

export { compareDescriptor, spreadDescriptor };
