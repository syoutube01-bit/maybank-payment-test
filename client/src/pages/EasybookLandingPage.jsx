import { Link, useLocation, useNavigate } from "react-router";
import { PageStyle } from "../components/PageStyle";
import { usePartnerPurchase } from "../lib/usePartnerPurchase";
import css from "../styles/easybook-landing.css?inline";

const PARTNER_ID = "mbb-mae-easybook";

export default function EasybookLandingPage() {
    const navigate = useNavigate();
    const { search } = useLocation();
    const apiTestHref = "/index.html" + search;
    const { isBuying, paymentStatus, buy } = usePartnerPurchase(PARTNER_ID);

    return (
        <>
            <title>Easybook | Your next journey</title>
            <meta name="theme-color" content="#111827" />
            <PageStyle css={css} />
            <header className="site-header">
                <a
                    className="wordmark"
                    id="easybookBrand"
                    href="#"
                    aria-label="Easybook home"
                    onDoubleClick={event => {
                        event.preventDefault();
                        navigate(apiTestHref);
                    }}
                >
                    <span className="wordmark-icon" aria-hidden="true">e</span>
                    <span>easybook</span>
                </a>
                <div className="header-actions">
                    <Link className="api-test" id="myOrdersLink" to="/my-orders.html?partnerId=mbb-mae-easybook" data-partner-id={PARTNER_ID}>My orders</Link>
                    <Link className="api-test" id="apiTestLink" to={apiTestHref} hidden>API test</Link>
                </div>
            </header>
            <main className="page-shell">
                <div className="journey">
                    <section className="journey-copy" aria-label="Easybook landing">
                        <p className="eyebrow">Make the journey yours</p>
                        <h1>Easybook</h1>
                        <p className="headline">A better way to get there.</p>
                        <p className="intro">Find your way to the places you want to go. Your next journey starts with a simpler plan.</p>
                        <button
                            className="primary-link"
                            id="buyButton"
                            type="button"
                            disabled={isBuying}
                            onClick={() => buy({ amount: 100, remark: "Easybook" })}
                        >
                            <span>Buy Book</span>
                            <span className="arrow" aria-hidden="true">↗</span>
                        </button>
                        <p id="paymentStatus" role="status" aria-live="polite">{paymentStatus}</p>
                    </section>
                    <div className="artwork" aria-hidden="true">
                        <span className="art-label">The world is yours to explore</span>
                        <div className="orbit"></div>
                        <div className="travel-card">
                            <p className="card-label">A little more out there</p>
                            <div className="route">
                                <div className="route-stop"><strong>Here</strong><span>Where you are</span></div>
                                <div className="route-line"></div>
                                <div className="route-stop"><strong>There</strong><span>Where you could be</span></div>
                            </div>
                            <div className="card-footer"><span>Bus · Train · Ferry</span><span>Your next story</span></div>
                        </div>
                    </div>
                </div>
            </main>
        </>
    );
}
