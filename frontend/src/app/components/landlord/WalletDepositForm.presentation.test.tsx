import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const boundary = vi.hoisted(() => ({ load: vi.fn(() => { throw new Error('Provider loading denied in offline presentation tests'); }), write: vi.fn(() => { throw new Error('Financial API denied in offline presentation tests'); }) }));
vi.mock('@stripe/stripe-js', () => ({ loadStripe: boundary.load }));
vi.mock('@stripe/react-stripe-js', () => ({ Elements: () => { throw new Error('Payment provider UI denied'); }, PaymentElement: () => { throw new Error('Payment provider UI denied'); }, useStripe: () => null, useElements: () => null }));
vi.mock('../../api/client', () => ({ LandlordAPI: new Proxy({}, { get: () => boundary.write }) }));
import WalletDepositForm from './WalletDepositForm';

describe('native top-up presentation retains the unavailable-server boundary', () => {
  it.each([undefined, { enabled: true, blocked: false }, { enabled: true, blocked: true }])('never renders or loads a provider or initiates money actions when online payments are false; bank=%j', bank => {
    const onDone = vi.fn(), onAmountError = vi.fn();
    const html = renderToStaticMarkup(<div className="lichen lichen-light lichen-wallet"><WalletDepositForm amount={0} onlinePayments={false} bank={bank as any} onDone={onDone} onAmountError={onAmountError}/></div>);
    expect(html).toContain('wallet-payments-off'); expect(html).toContain('nothing can be charged here'); expect(html).not.toContain('<button'); expect(html).not.toContain('<iframe');
    expect(boundary.load).not.toHaveBeenCalled(); expect(boundary.write).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled(); expect(onAmountError).not.toHaveBeenCalled();
  });
});
