import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { PageStyle } from "../components/PageStyle";
import { getDpAccessToken } from "../lib/payment";
import { usePartnerPurchase } from "../lib/usePartnerPurchase";
import css from "../styles/ctos-landing.css?inline";

const PARTNER_ID = "mbb-mae-ctos";

export default function CtosLandingPage() {
    const navigate = useNavigate();
    const { search } = useLocation();
    const apiTestHref = "/index.html" + search;
    const { paymentSession, isBuying, paymentStatus, buy } = usePartnerPurchase(PARTNER_ID);
    const amountInputRef = useRef(null);
    const viewPartyStartedRef = useRef(false);
    const [termsAccepted, setTermsAccepted] = useState(true);
    const [paymentAmount, setPaymentAmount] = useState(100);
    const [amountDraft, setAmountDraft] = useState("100");
    const [isEditingAmount, setIsEditingAmount] = useState(false);
    const [viewPartyResponse, setViewPartyResponse] = useState("");

    useEffect(() => {
        if (isEditingAmount) amountInputRef.current.focus();
    }, [isEditingAmount]);

    useEffect(() => {
        if (viewPartyStartedRef.current) return;
        viewPartyStartedRef.current = true;
        (async () => {
            setViewPartyResponse("Loading...");
            try {
                const accessToken = await getDpAccessToken();
                const webInitToken = await paymentSession.getWebInitToken();
                const res = await fetch("/api/dp/view-party", {
                    method: "GET",
                    headers: { "x-webinit-token": webInitToken, "x-access-token": accessToken }
                });
                const text = await res.text();
                if (!res.ok) {
                    throw new Error("View Party: HTTP " + res.status);
                }
                const data = JSON.parse(text);
                const registeredName = data?.Data?.demographics?.partyName?.registeredName;
                if (typeof registeredName !== "string" || !registeredName.trim()) {
                    throw new Error("View Party returned no registered party name.");
                }
                setViewPartyResponse(
                    <>The registered party name in the <strong>View Party</strong> response is <strong>{registeredName.trim()}</strong></>
                );
            } catch (error) {
                setViewPartyResponse("Request failed: " + error.message);
            }
        })();
    }, [paymentSession]);

    function toggleAmountEditing() {
        if (isBuying) return;
        if (!isEditingAmount) {
            setAmountDraft(String(paymentAmount));
            setIsEditingAmount(true);
            return;
        }
        const amountInput = amountInputRef.current;
        const amount = Number(amountInput.value);
        amountInput.setCustomValidity("");
        if (!Number.isFinite(amount) || amount <= 0) {
            amountInput.setCustomValidity("Enter an amount greater than zero.");
        }
        if (!amountInput.reportValidity()) return;
        setPaymentAmount(amount);
        setIsEditingAmount(false);
    }

    function onBuy() {
        if (isBuying || isEditingAmount || !termsAccepted) return;
        return buy({ amount: paymentAmount, remark: "CTOS Score Report" });
    }

    return (
        <>
            <title>CTOS Score Report</title>
            <PageStyle css={css} />
            <main className="page">
                <div className="header-actions">
                    <Link className="api-test" id="myOrdersLink" to="/my-orders.html?partnerId=mbb-mae-ctos" data-partner-id={PARTNER_ID}>My orders</Link>
                    <Link className="api-test" id="apiTestLink" to={apiTestHref} hidden>API test</Link>
                </div>
                <header className="brand-row">
                    <div className="brand" id="ctosBrand" aria-label="CTOS Score" onDoubleClick={() => navigate(apiTestHref)}>
                        <h1>CTOS</h1>
                        <span className="registered" aria-hidden="true">®</span>
                        <span className="score-label">Score</span>
                    </div>
                    <svg className="score-gauge" viewBox="0 0 180 106" role="img" aria-label="CTOS score range from 300 to 850">
                        <path d="M30 80 A60 60 0 0 1 41.5 44.7" fill="none" stroke="#ef342e" strokeWidth="18"/>
                        <path d="M41.5 44.7 A60 60 0 0 1 71.5 23" fill="none" stroke="#f47721" strokeWidth="18"/>
                        <path d="M71.5 23 A60 60 0 0 1 108.5 23" fill="none" stroke="#f5d313" strokeWidth="18"/>
                        <path d="M108.5 23 A60 60 0 0 1 138.5 44.7" fill="none" stroke="#8fba25" strokeWidth="18"/>
                        <path d="M138.5 44.7 A60 60 0 0 1 150 80" fill="none" stroke="#168843" strokeWidth="18"/>
                        <g fill="#fff" fontFamily="Arial, sans-serif" fontSize="7" fontWeight="700" textAnchor="middle">
                            <text x="40" y="63" transform="rotate(-61 40 63)">Poor</text>
                            <text x="57" y="39" transform="rotate(-42 57 39)">Fair</text>
                            <text x="90" y="29">Good</text>
                            <text x="124" y="39" transform="rotate(42 124 39)">Very good</text>
                            <text x="141" y="63" transform="rotate(61 141 63)">Excellent</text>
                        </g>
                        <path d="M90 80 L119 57" stroke="#777" strokeWidth="4" strokeLinecap="round"/>
                        <circle cx="90" cy="80" r="4" fill="#777"/>
                        <g fill="#333" fontFamily="Arial, sans-serif" fontSize="9" textAnchor="middle">
                            <text x="25" y="97">300</text>
                            <text x="155" y="97">850</text>
                        </g>
                    </svg>
                </header>

                <p className="description">Your CTOS Score is a 3-digit number that shows you how likely you are to be accepted for credit; such as credit cards, car loans, housing loans &amp; education loans. It is based on your past credit repayment behaviour, and is used to predict how good you would be at repaying future credit.</p>

                <hr />

                <section aria-labelledby="email-heading">
                    <h2 id="email-heading">Your Maybank registered email</h2>
                    <div className="email-row">
                        <span>Saravan***jan@yopmail.com</span>
                        <button className="outline-button" type="button">Update</button>
                    </div>
                    <p className="privacy">CTOS is committed to protecting your privacy in accordance with the Personal Data Protection Act 2010 of Malaysia (PDPA).</p>
                </section>

                <section className="payment-section" aria-labelledby="payment-heading">
                    <hr />
                    <h2 id="payment-heading">Payment Details</h2>
                    <div className="payment-summary">
                        <div>
                            <p className="report-name">CTOS Score Report</p>
                            <ul className="report-items">
                                <li>CTOS Score</li>
                                <li>CCRIS Records (BNM)</li>
                            </ul>
                        </div>
                        <div className="amount">
                            <div className="price" id="amountDisplay" hidden={isEditingAmount}>{"RM" + paymentAmount}</div>
                            <input
                                className="amount-input"
                                id="amountInput"
                                ref={amountInputRef}
                                type="number"
                                min="0.01"
                                step="0.01"
                                value={amountDraft}
                                onChange={event => {
                                    event.target.setCustomValidity("");
                                    setAmountDraft(event.target.value);
                                }}
                                required
                                aria-label="Amount in MYR"
                                hidden={!isEditingAmount}
                            />
                            <div className="tax">Incl. of Service Tax</div>
                            <button
                                className="outline-button amount-button"
                                id="amountButton"
                                type="button"
                                aria-controls="amountInput"
                                aria-expanded={isEditingAmount ? "true" : "false"}
                                disabled={isBuying}
                                onClick={toggleAmountEditing}
                            >{isEditingAmount ? "Save" : "Edit"}</button>
                        </div>
                    </div>

                    <label className="promo-label" htmlFor="promoCode">I Have a Promo Code</label>
                    <div className="promo-row">
                        <input className="promo-input" id="promoCode" type="text" placeholder="Enter promo code" />
                        <button className="outline-button" type="button">Apply</button>
                    </div>

                    <label className="agreement">
                        <input
                            id="termsAgreement"
                            type="checkbox"
                            checked={termsAccepted}
                            onChange={event => setTermsAccepted(event.target.checked)}
                        />
                        <span>I agree with CTOS&apos;s</span>
                        <a href="#terms">Terms &amp; Conditions</a>
                    </label>

                    <button
                        className="buy-button"
                        id="buyButton"
                        type="button"
                        disabled={isBuying || isEditingAmount || !termsAccepted}
                        onClick={onBuy}
                    >Buy</button>
                    <p id="paymentStatus" role="status" style={{ overflowWrap: "anywhere" }}>{paymentStatus}</p>
                    <p id="viewPartyResponse" role="status" style={{ overflowWrap: "anywhere" }}>{viewPartyResponse}</p>
                </section>
            </main>
        </>
    );
}
