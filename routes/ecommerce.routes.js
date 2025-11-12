const express = require('express');
const router = express.Router();
const {getBlogPosts, getFooter, getServicesWeOffer, getShopCategory} = require('../controller/ecommerce.controller');

router.get("/blog-post", getBlogPosts);
router.get("/footer-links", getFooter);
router.get("/services-we-offer", getServicesWeOffer);
router.get("/shop-by-category", getShopCategory);

module.exports = router; 