import { Route, Routes } from "react-router";
import ApiTestPage from "./pages/ApiTestPage";
import CtosLandingPage from "./pages/CtosLandingPage";
import DPLandingPage from "./pages/DPLandingPage";
import EasybookLandingPage from "./pages/EasybookLandingPage";
import EsimLandingPage from "./pages/EsimLandingPage";
import LookupPaymentStatusPage from "./pages/LookupPaymentStatusPage";
import MyOrdersPage from "./pages/MyOrdersPage";
import PaymentStatusPage from "./pages/PaymentStatusPage";
import PNTOrderCreationPage from "./pages/PNTOrderCreationPage";

// Paths match the original static HTML pages; keep in sync with spaRoutes in server.js.
export const routes = [
    { path: "/", element: <ApiTestPage /> },
    { path: "/index.html", element: <ApiTestPage /> },
    { path: "/DPLandingScreen.html", element: <DPLandingPage /> },
    { path: "/PNTOrderCreation.html", element: <PNTOrderCreationPage /> },
    { path: "/ctos-landing.html", element: <CtosLandingPage /> },
    { path: "/easybook-landing.html", element: <EasybookLandingPage /> },
    { path: "/esim-landing.html", element: <EsimLandingPage /> },
    { path: "/my-orders.html", element: <MyOrdersPage /> },
    { path: "/paymentstatus", element: <PaymentStatusPage /> },
    { path: "/paymentstatus.html", element: <PaymentStatusPage /> },
    { path: "/lookup-payment-status.html", element: <LookupPaymentStatusPage /> }
];

export default function App() {
    return (
        <Routes>
            {routes.map(({ path, element }) => <Route key={path} path={path} element={element} />)}
        </Routes>
    );
}
