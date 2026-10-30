import { Link, useLocation, useNavigate } from "react-router";
import { PageStyle } from "../components/PageStyle";
import { usePartnerPurchase } from "../lib/usePartnerPurchase";
import css from "../styles/esim-landing.css?inline";

const PARTNER_ID = "mbb-mae-esim";

export default function EsimLandingPage() {
    const navigate = useNavigate();
    const { search } = useLocation();
    const apiTestHref = "/index.html" + search;
    const { isBuying, paymentStatus, buy } = usePartnerPurchase(PARTNER_ID);

    return (
        <>
            <title>eSIM | Go beyond roaming</title>
            <meta name="theme-color" content="#11121b" />
            <PageStyle css={css} />
            <header className="site-header">
                <a
                    className="wordmark"
                    id="esimBrand"
                    href="#"
                    aria-label="eSIM home"
                    onDoubleClick={event => {
                        event.preventDefault();
                        navigate(apiTestHref);
                    }}
                >
                    <span className="wordmark-icon" aria-hidden="true">e</span>
                    <span>travel connectivity</span>
                </a>
                <div className="header-actions">
                    <Link className="api-test" id="myOrdersLink" to="/my-orders.html?partnerId=mbb-mae-esim" data-partner-id={PARTNER_ID}>My orders</Link>
                    <Link className="api-test" id="apiTestLink" to={apiTestHref} hidden>API test</Link>
                </div>
            </header>
            <main className="signal-stage">
                <section className="copy" aria-label="eSIM landing">
                    <p className="eyebrow"><span className="signal-dot" aria-hidden="true"></span>Stay in your own signal</p>
                    <h1>eSIM</h1>
                    <p className="headline">The world, <em>within reach.</em></p>
                    <p className="intro">Take your connection with you. Discover a simpler way to get online when the journey takes you somewhere new.</p>
                    <button
                        className="primary-link"
                        id="buyButton"
                        type="button"
                        disabled={isBuying}
                        onClick={() => buy({ amount: 100, remark: "eSIM" })}
                    >
                        <span>Buy Travel eSIM</span>
                        <span className="arrow" aria-hidden="true">↗</span>
                    </button>
                    <p id="paymentStatus" role="status" aria-live="polite">{paymentStatus}</p>
                </section>
                <div className="visual" aria-hidden="true">
                    <div className="orbit orbit-two"></div>
                    <div className="orbit orbit-three"></div>
                    <div className="orbit"></div>
                    <div className="phone">
                        <div className="phone-screen">
                            <div className="speaker"></div>
                            <div className="screen-content">
                                <p className="screen-label">Your connection</p>
                                <p className="screen-title">Ready to roam?</p>
                                <div className="coverage">e</div>
                                <div className="status-card">
                                    <div className="status-copy"><strong>Signal is yours</strong><span>Wherever you go next</span></div>
                                    <span className="signal-bars"><i></i><i></i><i></i><i></i></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </>
    );
}
