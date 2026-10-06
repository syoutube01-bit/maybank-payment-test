const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const MAYBANK_API_BASE_URL = "https://payments-npas.maybank.com.my/sit/";
const MAYBANK_CREATE_ORDER_PATH = "payment-sdk/v1/orders";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve HTML
app.use(express.static(path.join(__dirname, "public")));

// Payment status screen (deep link target: /paymentstatus?oid=MBB232)
app.get("/paymentstatus", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "paymentstatus.html"));
});

// Create Maybank payment order
app.post("/api/create-order", async (req, res) => {
    try {
        const {
            webinitToken,
            partnerId,
            partnerInvoiceId,
            partnerReferenceId,
            currency,
            amount,
            remark
        } = req.body;

        if (!webinitToken) {
            return res.status(400).json({
                success: false,
                message: "webinitToken is required"
            });
        }

        if (!partnerId) {
            return res.status(400).json({
                success: false,
                message: "partnerId is required"
            });
        }

        const requestBody = {
            partnerInvoiceId,
            partnerReferenceId,
            currency,
            amount,
            remark
        };
        console.log("Create orderRequest Body:", requestBody);

        const requestHeaders = {
            "Content-Type": "application/json",
            "x-mb-client-id": partnerId,
            "x-mb-e2e-id": "346918df-af88-4b3a-95e3-273eebf30aea",
            "x-mb-env": "U",
            "x-mb-timestamp": Date.now().toString(),
            "dip-authorization": `bearer ${webinitToken}`
        };

        console.log("Maybank API Request Headers:", requestHeaders);
        
        const createOrderUrl = new URL(
            MAYBANK_CREATE_ORDER_PATH,
            MAYBANK_API_BASE_URL
        ).toString();

        const response = await axios.post(
            createOrderUrl,
            requestBody,
            { headers: requestHeaders }
        );

        console.log("Maybank API Response:", response.data);
        return res.status(response.status).json({
            success: true,
            data: response.data
        });

    } catch (error) {

        const maybankError = error.response?.data || error.message;
        console.error("Maybank API Error:", maybankError);
        console.error("Maybank API Request URL:", error.config?.url);

        if (error.response?.headers?.location) {
            console.error(
                "Maybank API Redirect Location:",
                error.response.headers.location
            );
        }

        return res.status(
            error.response?.status || 500
        ).json({
            success: false,
            message: "Unable to create payment order",
            error: error.response?.data || error.message
        });
    }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});