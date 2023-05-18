const swiper = new Swiper(".swiper", {
    slidesPerView: 6,
    spaceBetween: 300,
    loop: true,
    grabCursor: true,
    centeredSlides: true,
    slideActiveClass: "active",
    navigation: {
        nextEl: ".next",
        prevEl: ".prev"
    },
    pagination: {
        el: ".pagination",
        clickable: true
    },
    autoplay: {
        enabled: true,
        delay: 5000
    },
    breakpoints: {
        320: {
            slidesPerView: 2,
            spaceBetween: 75
        },
        645: {
            slidesPerView: 2,
            spaceBetween: 150
        },
        // when window width is >= 320px
        1050: {
            slidesPerView: 3,
            spaceBetween: 150
        },
        // when window width is >= 480px
        1300: {
            slidesPerView: 4.1,
            spaceBetween: 90
        },
    }
});
