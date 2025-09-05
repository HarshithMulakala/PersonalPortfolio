document.querySelectorAll('.swiper').forEach(function (sliderEl) {
    new Swiper(sliderEl, {
        slidesPerView: 6,
        spaceBetween: 300,
        loop: true,
        grabCursor: true,
        centeredSlides: true,
        slideActiveClass: "active",
        navigation: {
            nextEl: sliderEl.querySelector('.next'),
            prevEl: sliderEl.querySelector('.prev')
        },
        pagination: {
            el: sliderEl.querySelector('.pagination'),
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
            1050: {
                slidesPerView: 3,
                spaceBetween: 150
            },
            1300: {
                slidesPerView: 4.1,
                spaceBetween: 90
            },
        }
    });
});
