const db = require('../config/database');

const getBlogPosts = async (req, res) => {
    try {
        const [response] = await db.pool.query(`SELECT title, date, tag FROM ecomm_blog_posts ORDER BY date DESC`);
        
        const blogPost = response ? response.map(item => ({
            title: item.title,
            date: item.date,
            tag: item.tag
        })) : [];
        
        return res.status(200).json({ blogPost });

    } catch (error) {
        console.error("Failed to fetch blog posts:", error);
        return res.status(500).json({message: "Crashed!"});
    }
}

const getFooter = async (req, res) => {
    try {
        const [categories] = await db.pool.query(`
            SELECT 
                fc.label as category,
                fi.label,
                fi.href as link
            FROM ecomm_footer_categories fc
            LEFT JOIN ecomm_footer_items fi ON fc.id = fi.category_id
            ORDER BY fc.display_order, fi.display_order
        `);
        
        // Always return 200, even with empty data
        if (!categories || categories.length === 0) {
            return res.status(200).json([]);
        }
        
        // Group items by category to match FooterApiResponse format
        const groupedData = categories.reduce((acc, row) => {
            const categoryName = row.category;
            let category = acc.find(cat => cat.category === categoryName);
            
            if (!category) {
                category = {
                    category: categoryName,
                    items: []
                };
                acc.push(category);
            }
            
            if (row.label && row.link) {
                category.items.push({
                    label: row.label,
                    link: row.link
                });
            }
            
            return acc;
        }, []);
        
        return res.status(200).json(groupedData);

    } catch (error) {
        console.error("Failed to fetch footer:", error);
        // Return empty array instead of error to prevent 404
        return res.status(200).json([]);
    }
}

const getServicesWeOffer = async (req, res) => {
    try {
        const [response] = await db.pool.query(`SELECT title, description FROM ecomm_services_we_offer ORDER BY display_order`);
        
        const services = response ? response.map(item => ({
            title: item.title,
            description: item.description
        })) : [];
        
        return res.status(200).json({ services });

    } catch (error) {
        console.error("Failed to fetch services:", error);
        return res.status(500).json({message: "Crashed!"});
    }
}

const getShopCategory = async (req, res) => {
    try {
        const [response] = await db.pool.query(`SELECT name FROM ecomm_shop_categories ORDER BY display_order`);
        if (!response || response.length === 0) {
            return res.status(404).json({message: "Not Found!"});
        }
        
        const categories = response.map(item => ({
            name: item.name
        }));
        
        return res.status(200).json({ categories });

    } catch (error) {
        console.error("Failed to fetch categories:", error);
        return res.status(500).json({message: "Crashed!"});
    }
}

module.exports = { getBlogPosts, getFooter, getServicesWeOffer, getShopCategory }